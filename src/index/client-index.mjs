// Worker-side source preparation and compact snapshot layout.
// Full text belongs in the document store; the layout tree retains metadata only.
import { foldCount, assertGeometryBudget } from '../render/geometry-budget.mjs';
const STRIDE = 96,
  SAMPLES = 16,
  BUFFER_LIMIT = 128 * 1024 * 1024,
  ROOT_PARENT = 0xffffffff;
const encoder = new TextEncoder(),
  whitespace = /\p{White_Space}/u;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
let segmenter;

function integer(value, name, min = 0, max = 0xffffffff) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function validPath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new Error('Invalid document path');
  return path;
}

function lineOffsets(text) {
  let lines = text.length && text.at(-1) !== '\n' ? 1 : 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  const offsets = new Uint32Array(lines + 1);
  let row = 1;
  for (let i = 0; i < text.length; i++)
    if (text.charCodeAt(i) === 10 && i + 1 < text.length) offsets[row++] = i + 1;
  offsets[lines] = text.length;
  return offsets;
}

function sourceLine(doc, line) {
  const start = doc.lineOffsets[line];
  let end = doc.lineOffsets[line + 1];
  if (end > start && doc.text.charCodeAt(end - 1) === 10) {
    end--;
    if (end > start && doc.text.charCodeAt(end - 1) === 13) end--;
  }
  return doc.text.slice(start, end);
}

function shape(line) {
  let columns = 0,
    indent = 0,
    leading = true,
    content = false,
    nonASCII = false,
    conservative = 0;
  for (const ch of line) {
    const ascii = ch.codePointAt(0) < 128;
    columns += ch === '\t' ? 4 - (columns % 4) : ascii ? 1 : 3;
    conservative += ch === '\t' ? 4 : ascii ? 1 : 3;
    nonASCII ||= !ascii;
    if (leading && (ch === ' ' || ch === '\t')) indent = columns;
    else leading = false;
    content ||= !whitespace.test(ch);
  }
  return { columns, indent, content, layout: nonASCII ? conservative : columns };
}

function profileEntry(indent, length, content) {
  const end = Math.min(4096, length),
    start = Math.min(end, indent);
  return content ? (start | ((end - start) << 16)) >>> 0 : 0;
}

/** Analyze one immutable document. All returned fields survive structuredClone/IDB. */
export function analyzeDocument({ id, path, revision, text, bytes }) {
  integer(id, 'id', 1, ROOT_PARENT - 1);
  validPath(path);
  if (typeof text !== 'string' || typeof revision !== 'string' || !revision)
    throw new Error('Document text and revision are required');
  if (text.length > 16 * 1024 * 1024) throw new Error('Document exceeds the 16 MiB source limit');
  const byteLength =
    bytes === undefined ? encoder.encode(text).byteLength : integer(bytes, 'bytes');
  if (byteLength > 16 * 1024 * 1024) throw new Error('Document exceeds the 16 MiB source limit');
  const offsets = lineOffsets(text),
    lines = offsets.length - 1,
    rawProfile = new Uint32Array(lines);
  const doc = {
    id,
    path,
    revision,
    text,
    bytes: byteLength,
    lines,
    columns: 0,
    displayLines: lines,
    displayColumns: 0,
    rawProfile,
    displayProfile: null,
    wrapping: null,
    wraps: new Uint32Array(0),
    lineOffsets: offsets,
  };
  const histogram = new Uint32Array(241);
  let nonblank = 0,
    maximum = 0;
  for (let row = 0; row < lines; row++) {
    const s = shape(sourceLine(doc, row));
    doc.columns = Math.max(doc.columns, Math.min(4096, s.layout));
    rawProfile[row] = profileEntry(s.indent, s.columns, s.content);
    if (s.content) {
      nonblank++;
      maximum = Math.max(maximum, s.columns);
      histogram[Math.min(240, s.columns)]++;
    }
  }
  doc.displayColumns = doc.columns;
  if (!nonblank) return doc;
  const rank = Math.ceil(nonblank * 0.9);
  let typical = 0,
    cumulative = 0;
  for (; typical < 240; typical++) {
    cumulative += histogram[typical];
    if (cumulative >= rank) break;
  }
  const width = Math.min(maximum, clamp(Math.ceil((typical + 16) / 8) * 8, 80, 240));
  if (maximum <= width) return doc;
  const wraps = [];
  let displayLines = 0;
  for (let row = 0; row < lines; row++) {
    const s = shape(sourceLine(doc, row)),
      count = s.content ? Math.max(1, Math.ceil(s.columns / width)) : 1;
    if (count > 1) wraps.push(row, s.columns, displayLines);
    displayLines += count;
  }
  const displayProfile = new Uint32Array(displayLines);
  let output = 0;
  for (let row = 0; row < lines; row++) {
    const s = shape(sourceLine(doc, row)),
      count = s.content ? Math.max(1, Math.ceil(s.columns / width)) : 1;
    for (let part = 0; part < count; part++) {
      const start = part * width,
        length = clamp(s.columns - start, 0, width),
        indent = clamp(s.indent - start, 0, length);
      displayProfile[output++] = profileEntry(indent, length, s.content);
    }
  }
  return {
    ...doc,
    displayColumns: width,
    displayLines,
    displayProfile,
    wraps: new Uint32Array(wraps),
    wrapping: { columns: width, lines: displayLines, sourceLines: lines },
  };
}

export function documentMetadata(doc) {
  const { id, path, revision, bytes, lines, columns, displayLines, displayColumns } = doc;
  return { id, path, revision, bytes, lines, columns, displayLines, displayColumns };
}

// Binary search sparse triples [original row, original width, first display row].
function wrapBefore(wraps, value, field) {
  let lo = 0,
    hi = wraps.length / 3;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (wraps[mid * 3 + field] <= value) lo = mid + 1;
    else hi = mid;
  }
  return (lo - 1) * 3;
}

function originalAt(doc, row) {
  const index = wrapBefore(doc.wraps, row, 2);
  if (index < 0) return { line: row, part: 0, width: null };
  const line = doc.wraps[index],
    length = doc.wraps[index + 1],
    first = doc.wraps[index + 2],
    width = doc.displayColumns,
    extra = Math.floor((length - 1) / width);
  if (row <= first + extra) return { line, part: row - first, width };
  return { line: row - (first - line + extra), part: 0, width: null };
}

function* graphemes(text) {
  if (!/[^\x00-\x7f]/.test(text)) {
    yield* text;
    return;
  }
  if (typeof Intl.Segmenter !== 'function')
    throw new Error('This browser needs Intl.Segmenter to display Unicode source safely');
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const item of segmenter.segment(text)) yield item.segment;
}

// Build only the requested part range, even for a megabyte-long logical line.
function projectedParts(raw, width, start, count) {
  if (width === null && !raw.includes('\t')) return [raw];
  const rowWidth = width ?? Number.MAX_SAFE_INTEGER,
    rows = Array.from({ length: count }, () => []);
  let column = 0;
  for (const cluster of graphemes(raw)) {
    const row = Math.floor(column / rowWidth);
    if (row >= start + count) break;
    if (cluster === '\t') {
      const spaces = 4 - (column % 4);
      for (let i = 0; i < spaces; i++, column++) {
        const target = Math.floor(column / rowWidth) - start;
        if (target >= 0 && target < count) rows[target].push(' ');
      }
    } else {
      if (row >= start) rows[row - start].push(cluster);
      for (const ch of cluster) column += ch.codePointAt(0) < 128 ? 1 : 3;
    }
  }
  return rows.map((row) => row.join(''));
}

export function documentPage(doc, { start = 0, count = 32, display = false } = {}) {
  integer(start, 'start');
  integer(count, 'count', 1, 512);
  const total = display ? doc.displayLines : doc.lines;
  if (start > total) throw new Error('start exceeds document line count');
  const stop = Math.min(total, start + count),
    sourceLines = [],
    lineMap = [],
    columnMap = [];
  for (let row = start; row < stop;) {
    if (!display) {
      sourceLines.push(sourceLine(doc, row));
      lineMap.push(row);
      columnMap.push(0);
      row++;
      continue;
    }
    const { line, part, width } = originalAt(doc, row);
    let length = 1;
    while (row + length < stop && originalAt(doc, row + length).line === line) length++;
    const projected = projectedParts(sourceLine(doc, line), width, part, length);
    for (let i = 0; i < length; i++) {
      sourceLines.push(projected[i] ?? '');
      lineMap.push(line);
      columnMap.push(width ? (part + i) * width : 0);
    }
    row += length;
  }
  return {
    id: doc.id,
    path: doc.path,
    revision: doc.revision,
    totalLines: total,
    sourceTotalLines: doc.lines,
    start,
    sourceLines,
    lineMap,
    columnMap,
    rawColumns: doc.columns,
    displayColumns: doc.displayColumns,
    display: !!display,
    wrapping: doc.wrapping,
    snapshot: true,
  };
}

export function sourceAddress(doc, { line = 0, column = 0 } = {}) {
  integer(line, 'line');
  integer(column, 'column');
  if (line >= Math.max(1, doc.lines)) throw new Error('line exceeds document line count');
  let displayLine = line,
    displayColumn = column;
  const index = wrapBefore(doc.wraps, line, 0);
  if (index >= 0) {
    const original = doc.wraps[index],
      length = doc.wraps[index + 1],
      row = doc.wraps[index + 2],
      width = doc.displayColumns,
      extra = Math.floor((length - 1) / width);
    if (original === line) {
      column = Math.min(length, column);
      const part = Math.min(extra, Math.floor(column / width));
      displayLine = row + part;
      displayColumn = column - part * width;
    } else displayLine = line + row - original + extra;
  }
  return { id: doc.id, revision: doc.revision, line, column, displayLine, displayColumn };
}

// Small revisioned ranges, not source/AST copies, cross back to the renderer.
export function sourceSelection(doc, { line = 0, column = 0, endLine, endColumn } = {}) {
  const address = sourceAddress(doc, { line, column }),
    hasEnd = endLine !== undefined && endColumn !== undefined;
  const start = hasEnd ? address : sourceAddress(doc, { line, column: 0 });
  endLine = hasEnd ? integer(endLine, 'endLine') : line + 1;
  endColumn = hasEnd ? integer(endColumn, 'endColumn') : 0;
  if (endLine < start.line || (endLine === start.line && endColumn < start.column))
    throw Error('Invalid source selection range');
  const end =
    endLine === doc.lines && endColumn === 0
      ? { line: endLine, column: 0, displayLine: doc.displayLines, displayColumn: 0 }
      : sourceAddress(doc, { line: endLine, column: endColumn });
  return {
    id: doc.id,
    revision: doc.revision,
    address,
    source: {
      start: { line: start.line, column: start.column },
      end: { line: end.line, column: end.column },
    },
    display: {
      start: { line: start.displayLine, column: start.displayColumn },
      end: { line: end.displayLine, column: end.displayColumn },
    },
  };
}

function naturalBounds(columns, lines, count) {
  return {
    w: count * ((columns + 4) * 0.45 + 2) + (count - 1) * 2,
    h: Math.ceil(Math.max(1, lines) / count) + (count === 1 ? 4 : 6),
  };
}

function panelCount(columns, lines, target) {
  let best = 1,
    bestScale = 0;
  for (let count = 1; count <= clamp(lines, 1, 32); count++) {
    const natural = naturalBounds(columns, lines, count),
      scale = Math.min(target.w / natural.w, target.h / natural.h);
    if (scale > bestScale) {
      best = count;
      bestScale = scale;
    }
  }
  return best;
}

function sourceWeight(columns, lines) {
  const count = panelCount(columns, lines, { w: 1, h: 1 }),
    natural = naturalBounds(columns, lines, count),
    scale = Math.min(1, 2048 / natural.h);
  return natural.w * scale * natural.h * scale;
}

// UTF-8 lexical order equals Unicode scalar order, including supplementary paths.
function pathOrder(a, b) {
  const x = a.path,
    y = b.path;
  let i = 0,
    j = 0;
  while (i < x.length && j < y.length) {
    const ac = x.codePointAt(i),
      bc = y.codePointAt(j);
    if (ac !== bc) return ac - bc;
    i += ac > 65535 ? 2 : 1;
    j += bc > 65535 ? 2 : 1;
  }
  return (i < x.length ? 1 : 0) - (j < y.length ? 1 : 0);
}

class WeightTree {
  constructor(children) {
    this.base = 1;
    while (this.base < children.length) this.base *= 2;
    this.sums = new Float64Array(this.base * 2);
    for (let i = 0; i < children.length; i++) this.sums[this.base + i] = children[i].weight;
    for (let i = this.base - 1; i > 0; i--) this.sums[i] = this.sums[i * 2] + this.sums[i * 2 + 1];
  }
  total(start, end) {
    let sum = 0;
    for (
      start += this.base, end += this.base;
      start < end;
      start = Math.floor(start / 2), end = Math.floor(end / 2)
    ) {
      if (start % 2) sum += this.sums[start++];
      if (end % 2) sum += this.sums[--end];
    }
    return sum;
  }
  split(start, end) {
    const whole = this.total(start, end);
    let prefix = 0;
    const crossing = (index, lo, hi) => {
      if (hi <= start || lo >= end) return null;
      if (lo >= start && hi <= end) {
        const next = prefix + this.sums[index] / whole;
        if (next < 0.5) {
          prefix = next;
          return null;
        }
        if (hi - lo === 1) return [lo, prefix, next];
      }
      const mid = (lo + hi) / 2;
      return crossing(index * 2, lo, mid) ?? crossing(index * 2 + 1, mid, hi);
    };
    const [index, before, after] = crossing(1, 0, this.base);
    return index > start && (index + 1 === end || 0.5 - before <= after - 0.5)
      ? [index, before]
      : [index + 1, after];
  }
}

const floatBits = new DataView(new ArrayBuffer(8));
function splitEdge(start, end, ideal, before, after) {
  floatBits.setFloat64(0, end, true);
  floatBits.setBigUint64(0, floatBits.getBigUint64(0, true) + 1n, true);
  const step = floatBits.getFloat64(0, true) - end;
  const minimum = start + before * step,
    maximum = end - after * step;
  if (minimum > maximum)
    throw new Error('Repository nesting exceeds the precise layout coordinate limit');
  return clamp(Math.round(ideal / step) * step, minimum, maximum);
}

function partition(children, target) {
  if (!children.length) return;
  const weights = new WeightTree(children),
    pending = [[0, children.length, target]];
  while (pending.length) {
    const [start, end, b] = pending.pop();
    if (end - start === 1) {
      children[start].bounds = b;
      continue;
    }
    const [split, fraction] = weights.split(start, end);
    let first, second;
    if (b.w >= b.h) {
      const right = b.x + b.w,
        edge = splitEdge(b.x, right, b.x + b.w * fraction, split - start, end - split);
      first = { ...b, w: edge - b.x };
      second = { ...b, x: edge, w: right - edge };
    } else {
      const bottom = b.y + b.h,
        edge = splitEdge(b.y, bottom, b.y + b.h * fraction, split - start, end - split);
      first = { ...b, h: edge - b.y };
      second = { ...b, y: edge, h: bottom - edge };
    }
    pending.push([split, end, second], [start, split, first]);
  }
}

const words = (text) => new Set(text.split(' '));
const TEST_COMPONENTS = words('test tests testing testdata fixtures __tests__ __fixtures__');
const BUILD_COMPONENTS = words('build config configs configuration cmake .github');
const DOC_COMPONENTS = words('doc docs documentation'),
  DATA_COMPONENTS = words('data assets schema schemas resources');
const TEST_TOKENS = words(
  'test tests unittest unittests apitest apitests browsertest browsertests perftest perftests spec',
);
const DOC_NAMES = words(
  'readme license licence copying authors owners atl_owners contributing code_of_conduct changelog changes notice patents security',
);
const BUILD_NAMES = words(
  'build build.gn build.bazel workspace workspace.bazel module.bazel deps presubmit.py makefile gnumakefile dockerfile containerfile cmakelists.txt cargo.toml cargo.lock package.json package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml gemfile rakefile requirements.txt pipfile pipfile.lock pyproject.toml setup.py setup.cfg go.mod go.sum .gn .bazelrc .gitignore .gitattributes .gitmodules .editorconfig .clang-format .clang-tidy .npmrc .nvmrc',
);
const TYPES = new Map();
for (const [group, family, shade] of [
  ['c', 'source', -2],
  ['cc cpp cxx c++ h hh hpp hxx ipp inl', 'source', 0],
  ['rs', 'source', -3],
  ['py pyi', 'source', 3],
  ['js jsx mjs cjs', 'source', -1],
  ['ts tsx mts cts', 'source', 1],
  ['html htm xhtml', 'source', -2],
  ['css scss sass less swift cs php', 'source', 2],
  ['m mm kt kts', 'source', 1],
  ['java s asm', 'source', -1],
  ['go', 'source', -2],
  ['rb metal glsl hlsl wgsl vert frag', 'source', 3],
  ['sh bash zsh fish bat cmd ps1', 'source', -3],
  ['md markdown mdown', 'documentation', 0],
  ['rst', 'documentation', 2],
  ['txt text', 'documentation', -1],
  ['adoc asciidoc', 'documentation', 1],
  ['tex', 'documentation', -2],
  ['gn gni', 'build', 0],
  ['gyp gypi yaml yml', 'build', 1],
  ['cmake toml', 'build', -1],
  ['bzl bazel ini cfg conf properties', 'build', 2],
  ['ninja lock', 'build', -2],
  ['gradle', 'build', 3],
  ['json json5 jsonl', 'data', -1],
  ['xml xsd xsl xslt dtd plist svg', 'data', 2],
  ['proto', 'data', -2],
  ['mojom ttf otf woff woff2', 'data', 1],
  ['idl fidl webidl', 'data', 3],
  ['csv tsv png jpg jpeg gif webp ico pdf', 'data', 0],
  ['sql', 'data', -3],
  ['mp3 wav ogg mp4 webm', 'data', -1],
])
  for (const ext of group.split(' ')) TYPES.set(ext, [family, shade]);

function documentationName(name) {
  const tokens = name.split('.');
  return (
    DOC_NAMES.has(name) ||
    (tokens.length > 1 &&
      DOC_NAMES.has(tokens[0]) &&
      (['readme', 'license', 'licence', 'copying'].includes(tokens[0]) ||
        ['md', 'txt', 'rst', 'html'].includes(tokens.at(-1))))
  );
}
function buildName(name) {
  const tokens = name.split('.');
  return (
    BUILD_NAMES.has(name) ||
    ['tsconfig', 'jsconfig'].includes(tokens[0]) ||
    ['.eslintrc', '.prettierrc'].includes(name) ||
    ['.eslintrc.', '.prettierrc.', 'dockerfile.'].some((p) => name.startsWith(p)) ||
    tokens.slice(0, -1).includes('config')
  );
}
function appearance(path, kind) {
  let family = 'directory',
    shade = 0;
  if (kind) {
    const original = path.split('/').at(-1),
      parts = path.toLowerCase().split('/'),
      name = parts.pop(),
      ext = name.includes('.') ? name.split('.').at(-1) : '';
    let type;
    [type, shade] = TYPES.get(ext) ?? [buildName(name) ? 'build' : 'other', 0];
    if (
      [
        'cmakelists.txt',
        'makefile',
        'gnumakefile',
        'dockerfile',
        'containerfile',
        'deps',
        'build',
        'workspace',
      ].includes(name)
    ) {
      type = 'build';
      shade = 0;
    }
    const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name,
      originalStem = original.includes('.')
        ? original.slice(0, original.lastIndexOf('.'))
        : original;
    const testName =
      stem.split(/[_\-.]/).some((t) => TEST_TOKENS.has(t)) ||
      /(Test|Tests|Spec)$/.test(originalStem) ||
      /^Test\p{Lu}/u.test(originalStem);
    if (documentationName(name)) family = 'documentation';
    else if (buildName(name)) family = 'build';
    else if (type === 'documentation') family = 'documentation';
    else if (parts.some((p) => TEST_COMPONENTS.has(p)) || testName) family = 'tests';
    else if (type === 'build' || parts.some((p) => BUILD_COMPONENTS.has(p))) family = 'build';
    else if (parts.some((p) => DOC_COMPONENTS.has(p))) family = 'documentation';
    else if (parts.some((p) => DATA_COMPONENTS.has(p))) family = 'data';
    else family = type;
  }
  const neutral = family === 'directory' || family === 'other';
  const hue =
    {
      source: 0.56,
      tests: 0.75,
      build: 0.105,
      documentation: 0.39,
      data: 0.025,
      other: 0.59,
      directory: 0.59,
    }[family] + (neutral ? 0 : shade * 0.006);
  const sat = neutral ? 0.24 : 0.61,
    value = (neutral ? 0.56 : 0.86) + shade * 0.01;
  const sector = Math.floor(hue * 6),
    fraction = hue * 6 - sector,
    p = value * (1 - sat),
    q = value * (1 - fraction * sat),
    t = value * (1 - (1 - fraction) * sat);
  const rgb = [
    [value, t, p],
    [q, value, p],
    [p, value, t],
    [p, q, value],
    [t, p, value],
    [value, p, q],
  ][sector % 6];
  return (
    (Math.round(rgb[0] * 255) |
      (Math.round(rgb[1] * 255) << 8) |
      (Math.round(rgb[2] * 255) << 16) |
      0xff000000) >>>
    0
  );
}

function sizeLimit(bytes, name) {
  if (!Number.isSafeInteger(bytes) || bytes > BUFFER_LIMIT)
    throw new Error(
      `${name} buffer exceeds the current 128 MiB browser limit; import a smaller repository or folder`,
    );
}

function sampleProfile(profile, lines, panels, output, offset) {
  if (!(profile instanceof Uint32Array) || profile.length !== lines)
    throw new Error('Document profile length differs from its snapshot metadata');
  const count = Math.max(1, lines),
    q = Math.floor(count / panels),
    r = count % panels;
  for (let panel = 0; panel < panels; panel++) {
    const start = panel * q + Math.min(panel, r),
      length = q + (panel < r ? 1 : 0);
    for (let sample = 0; sample < SAMPLES; sample++) {
      const lo = start + Math.floor((sample * length) / SAMPLES),
        hi = Math.min(lines, start + Math.floor(((sample + 1) * length) / SAMPLES));
      let best = 0,
        extent = 0;
      for (let i = lo; i < hi; i++) {
        const value = profile[i],
          candidate = value >>> 16 ? (value & 65535) + (value >>> 16) : 0;
        if (candidate > extent) {
          best = value;
          extent = candidate;
        }
      }
      output.setUint32(offset++ * 4, best, true);
    }
  }
  return offset;
}

/** Build a ready snapshot from compact metadata, loading one analyzed source at a time. */
export async function buildSnapshot(metas, repo, readDocument, onProgress = () => {}) {
  if (!Array.isArray(metas) || !metas.length)
    throw new Error('No supported documents were found in this empty repository');
  let maxId = 0;
  const ids = new Set(),
    pathsSeen = new Set();
  for (const m of metas) {
    integer(m.id, 'id', 1, ROOT_PARENT - 1);
    validPath(m.path);
    if (ids.has(m.id)) throw new Error(`Duplicate document id ${m.id}`);
    if (pathsSeen.has(m.path)) throw new Error(`Duplicate document path ${m.path}`);
    ids.add(m.id);
    pathsSeen.add(m.path);
    maxId = Math.max(maxId, m.id);
    for (const field of ['bytes', 'lines', 'columns', 'displayLines', 'displayColumns'])
      integer(m[field], field);
    if (m.columns > 4096 || m.displayColumns > 4096)
      throw new Error('Document column metadata exceeds the map limit');
  }
  const folder = (path) => ({
    id: integer(++maxId, 'folder id', 1, ROOT_PARENT - 1),
    path,
    kind: 0,
    children: [],
    lines: 0,
    bytes: 0,
    columns: 0,
    displayLines: 0,
    displayColumns: 0,
    weight: 0,
  });
  const root = folder(''),
    directories = new Map([['', root]]);
  for (const meta of metas) {
    const parts = meta.path.split('/');
    parts.pop();
    let parent = root,
      path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      if (pathsSeen.has(path)) throw new Error(`Document path is also a directory: ${path}`);
      if (!directories.has(path)) {
        const node = folder(path);
        directories.set(path, node);
        parent.children.push(node);
      }
      parent = directories.get(path);
    }
    parent.children.push({
      ...documentMetadata(meta),
      kind: 1,
      children: [],
      weight: sourceWeight(meta.displayColumns, meta.displayLines),
    });
  }
  const nodes = [],
    pending = [[root, ROOT_PARENT, 0]];
  while (pending.length) {
    const [n, parent, depth] = pending.pop();
    n.index = nodes.length;
    n.parent = parent;
    n.depth = depth;
    nodes.push(n);
    n.children.sort(pathOrder);
    for (let i = n.children.length - 1; i >= 0; i--)
      pending.push([n.children[i], n.index, depth + 1]);
  }
  for (let i = nodes.length - 1; i > 0; i--) {
    const n = nodes[i],
      parent = nodes[n.parent];
    parent.lines += n.lines;
    parent.bytes += n.bytes;
    parent.displayLines += n.displayLines;
    parent.weight += n.weight;
  }
  root.bounds = { x: 0, y: 0, w: 100000, h: 70000 };
  let panels = 0,
    pathBytes = 0;
  for (const n of nodes) {
    if (n.kind) {
      n.panels = panelCount(n.displayColumns, n.displayLines, n.bounds);
      panels += n.panels;
    } else {
      n.panels = 1;
      partition(n.children, n.bounds);
    }
    n.encodedPath = encoder.encode(n.path);
    n.pathOffset = pathBytes;
    pathBytes += n.encodedPath.length;
  }
  const folds = nodes.reduce((sum, n) => sum + (n.kind ? foldCount(n.lines, n.panels) : 0), 0);
  const nodeBytes = nodes.length * STRIDE,
    previewBytes = panels * SAMPLES * 8;
  sizeLimit(nodeBytes, 'Nodes');
  sizeLimit(pathBytes, 'Paths');
  sizeLimit(previewBytes, 'Preview');
  assertGeometryBudget(metas.length, folds, directories.size);
  onProgress({
    phase: 'layout',
    completed: metas.length,
    total: metas.length,
    message: `Packed ${metas.length.toLocaleString()} files`,
  });
  const nodeBuffer = new ArrayBuffer(nodeBytes),
    pathBuffer = new ArrayBuffer(pathBytes),
    previewBuffer = new ArrayBuffer(previewBytes);
  const nodeView = new DataView(nodeBuffer),
    pathView = new Uint8Array(pathBuffer),
    previewView = new DataView(previewBuffer);
  let previewOffset = 0,
    completed = 0;
  for (const n of nodes) {
    let displayOffset = 0,
      rawOffset = 0;
    if (n.kind) {
      const doc = await readDocument(n.id);
      if (!doc) throw new Error(`Missing stored document ${n.path}`);
      if (doc.id !== n.id || doc.path !== n.path || doc.revision !== n.revision)
        throw new Error(`Document revision changed while building ${n.path}`);
      if (
        doc.lines !== n.lines ||
        doc.displayLines !== n.displayLines ||
        doc.columns !== n.columns ||
        doc.displayColumns !== n.displayColumns
      )
        throw new Error(`Document metadata changed while building ${n.path}`);
      displayOffset = previewOffset;
      previewOffset = sampleProfile(
        doc.displayProfile ?? doc.rawProfile,
        n.displayLines,
        n.panels,
        previewView,
        previewOffset,
      );
      rawOffset = previewOffset;
      previewOffset = sampleProfile(doc.rawProfile, n.lines, n.panels, previewView, previewOffset);
      completed++;
      if (completed % 128 === 0 || completed === metas.length)
        onProgress({
          phase: 'previews',
          completed,
          total: metas.length,
          message: `Prepared ${completed.toLocaleString()} / ${metas.length.toLocaleString()} file previews`,
        });
    }
    const offset = n.index * STRIDE,
      b = n.bounds;
    for (const [i, value] of [b.x, b.y, b.w, b.h].entries())
      nodeView.setFloat64(offset + i * 8, value, true);
    const fields = [
      n.id,
      n.parent,
      n.lines,
      n.columns,
      n.panels,
      n.depth,
      n.kind,
      appearance(n.path, n.kind),
      n.displayLines,
      n.displayColumns,
      displayOffset,
      rawOffset,
      n.pathOffset,
      n.encodedPath.length,
      0,
      0,
    ];
    for (let i = 0; i < fields.length; i++)
      nodeView.setUint32(offset + 32 + i * 4, integer(fields[i], 'binary field'), true);
    pathView.set(n.encodedPath, n.pathOffset);
  }
  const sourceRepo = repo.fullName ?? repo.name,
    commit = repo.commit,
    projectId = repo.projectId;
  const revision = `client-v1:${projectId}:${commit}`;
  const manifest = {
    version: 1,
    revision,
    artifact: `snapshot-${projectId}`,
    count: nodes.length,
    maxId,
    root: [0, 0, 100000, 70000],
    stats: {
      files: metas.length,
      lines: root.lines,
      bytes: root.bytes,
      folders: directories.size,
      panels,
      skipped: repo.skipped ?? 0,
    },
    nodeStride: STRIDE,
    previewSamples: SAMPLES,
    previewLimitBytes: BUFFER_LIMIT,
    sourceRepo,
    commit,
    projectId,
    source: {
      repository: sourceRepo,
      commit,
      projectId,
      schemaVersion: '4',
      displayLayoutVersion: '1',
    },
    buffers: {
      'nodes.bin': { bytes: nodeBytes },
      'paths.bin': { bytes: pathBytes },
      'previews.bin': { bytes: previewBytes },
    },
    snapshot: true,
  };
  return { manifest, nodes: nodeBuffer, paths: pathBuffer, previews: previewBuffer };
}
