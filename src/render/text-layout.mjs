// Source columns deliberately follow Atlas's conservative profile budget,
// not browser font ink width: ASCII scalar = 1, other scalar = 3, tabs = 4 stops.
// Intl.Segmenter keeps combining marks and ZWJ sequences on their base row.
export const TILE_COLUMNS = 128;
export const TILE_ROWS = 32;
export const CELL_WIDTH = 9;
export const ROW_HEIGHT = 20;

export const LEXICAL_COLORS = Object.freeze({
  plain: '#d1dee8',
  comment: '#6ea396',
  string: '#e0b875',
  keyword: '#b899f0',
  number: '#e89e77',
});

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const keywords = new Set(
  (
    'abstract actor as async await bool boolean break case catch char class const continue ' +
    'default def defer delete do double else enum export extends extern false final finally float fn for from func ' +
    'function guard if implements import in include inline instanceof int interface internal is let long module ' +
    'mut namespace new nil none null nullptr of operator override package private protected protocol pub public ' +
    'raise readonly repeat require return self short signed sizeof static string struct super switch template ' +
    'this throw throws trait true try type typedef typeof union unsigned use using var virtual void volatile ' +
    'where while with yield'
  ).split(' '),
);
const wordStart = /[A-Za-z_$]/;
const wordPart = /[A-Za-z0-9_$]/;

function language(path) {
  const lower = path.toLowerCase();
  return {
    hash:
      /\.(?:py|pyi|rb|sh|bash|zsh|fish|yaml|yml|toml|r|pl|pm|cmake)$/.test(lower) ||
      /(?:^|\/)(?:makefile|dockerfile|cmakelists\.txt)$/.test(lower),
    triple: /\.(?:py|pyi)$/.test(lower),
    sql: /\.sql$/.test(lower),
  };
}

/** Lightweight lexical coloring, not parsing or semantic name resolution.
 * State is reusable across contiguous rows. A cold page begins in normal state;
 * multiline constructs opened before that page can therefore be colored plainly.
 */
export function lexLine(text, { path = '', state = { mode: 'normal' }, continued = false } = {}) {
  const syntax = language(path),
    tokens = [];
  let cursor = 0,
    mode = state.mode || 'normal',
    quote = state.quote || '';
  function add(start, end, kind) {
    if (end <= start) return;
    const last = tokens.at(-1);
    if (last && last.kind === kind && last.end === start) last.end = end;
    else tokens.push({ start, end, kind });
  }
  function quoted(start, contentStart) {
    let end = contentStart,
      closed = false;
    while (end < text.length) {
      if (text[end] === '\\') {
        end = Math.min(text.length, end + 2);
        continue;
      }
      if (text.startsWith(quote, end)) {
        end += quote.length;
        closed = true;
        break;
      }
      end++;
    }
    add(start, end, 'string');
    cursor = end;
    if (closed) {
      mode = 'normal';
      quote = '';
    }
  }
  while (cursor < text.length) {
    const start = cursor;
    if (mode === 'comment') {
      const close = text.indexOf('*/', cursor);
      cursor = close < 0 ? text.length : close + 2;
      add(start, cursor, 'comment');
      if (close >= 0) mode = 'normal';
    } else if (mode === 'line-comment') {
      add(start, text.length, 'comment');
      cursor = text.length;
    } else if (mode === 'string') {
      quoted(start, cursor);
    } else if (
      text.startsWith('//', cursor) ||
      (syntax.hash && text[cursor] === '#') ||
      (syntax.sql && text.startsWith('--', cursor))
    ) {
      add(start, text.length, 'comment');
      cursor = text.length;
      mode = 'line-comment';
    } else if (text.startsWith('/*', cursor)) {
      mode = 'comment';
      cursor += 2;
      const close = text.indexOf('*/', cursor);
      cursor = close < 0 ? text.length : close + 2;
      add(start, cursor, 'comment');
      if (close >= 0) mode = 'normal';
    } else if ('\'"`'.includes(text[cursor])) {
      quote =
        syntax.triple && (text.startsWith('"""', cursor) || text.startsWith("'''", cursor))
          ? text.slice(cursor, cursor + 3)
          : text[cursor];
      mode = 'string';
      quoted(start, cursor + quote.length);
    } else if (wordStart.test(text[cursor])) {
      cursor++;
      while (cursor < text.length && wordPart.test(text[cursor])) cursor++;
      add(start, cursor, keywords.has(text.slice(start, cursor)) ? 'keyword' : 'plain');
    } else if (/[0-9]/.test(text[cursor])) {
      const match =
        /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)(?:[uUlLfF]+)?/.exec(
          text.slice(cursor),
        );
      cursor += match ? match[0].length : 1;
      add(start, cursor, 'number');
    } else {
      cursor++;
      add(start, cursor, 'plain');
    }
  }
  // Display wraps are not source newlines. Preserve line comments and ordinary
  // quotes until the last display row of the original line.
  if (
    !continued &&
    (mode === 'line-comment' || (mode === 'string' && quote.length === 1 && quote !== '`'))
  ) {
    mode = 'normal';
    quote = '';
  }
  return { tokens, state: { mode, quote } };
}

/** Returned run columns are row-relative, before tile horizontal translation.
 * A cluster overlapping the left tile edge is retained whole and canvas-clipped.
 * Only ordinary ASCII can coalesce into runs; wider clusters reserve fixed-width cells.
 */
export function layoutLine(
  text,
  { column = 0, count = TILE_COLUMNS, origin = 0, tokens = null } = {},
) {
  const runs = [],
    endColumn = column + count;
  let cells = 0,
    tokenIndex = 0;
  for (const part of segmenter.segment(text)) {
    const grapheme = part.segment,
      start = cells;
    let width = 0;
    if (grapheme === '\t') width = 4 - ((origin + cells) % 4);
    else for (const scalar of grapheme) width += scalar.codePointAt(0) < 128 ? 1 : 3;
    cells += width;
    if (start >= endColumn) break;
    if (cells <= column || /^\s+$/u.test(grapheme) || /[\u0000-\u001f\u007f]/.test(grapheme))
      continue;
    while (tokens && tokenIndex < tokens.length - 1 && tokens[tokenIndex].end <= part.index)
      tokenIndex++;
    const kind = tokens?.[tokenIndex]?.kind || 'plain';
    const ascii = grapheme.length === 1 && grapheme.charCodeAt(0) < 128;
    const last = runs.at(-1);
    if (ascii && last?.ascii && last.kind === kind && last.column + last.cells === start) {
      last.text += grapheme;
      last.cells += width;
    } else runs.push({ text: grapheme, column: start, cells: width, kind, ascii });
  }
  return { runs, columns: cells };
}
