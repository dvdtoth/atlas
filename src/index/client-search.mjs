// Worker-side syntax metadata and local literal search. Only grammar modules are
// cached: every parser, cursor and tree is destroyed before extraction returns.
import { Parser, Language } from '../../vendor/tree-sitter.js';

const MAX_PARSE_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 8192;
const MAX_DEPTH = 256;
const PARSE_MS = 100;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
// A JS substring may keep its full source backing store alive. Copy compact
// retained strings through UTF-8 so an index cannot pin every original document.
const compactText = (text) => DECODER.decode(ENCODER.encode(text));
const GRAMMARS = Object.freeze({
  c: 'c',
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  rs: 'rust',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  pyi: 'python',
});
const FUNCTION_TYPES = new Set([
  'function_definition',
  'function_item',
  'function_declaration',
  'generator_function_declaration',
  'method_definition',
  'method_signature',
  'function_signature_item',
]);
const TYPE_TYPES = new Set([
  'class_specifier',
  'struct_specifier',
  'union_specifier',
  'enum_specifier',
  'class_declaration',
  'class_definition',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'struct_item',
  'enum_item',
  'union_item',
  'trait_item',
  'type_item',
]);
const NAME_TYPES = new Set([
  'identifier',
  'field_identifier',
  'type_identifier',
  'qualified_identifier',
  'operator_name',
  'destructor_name',
]);
const CONTAINERS = new Set(['function', 'type', 'namespace']);
const DESTRUCTURING = new Set([
  'array_pattern',
  'object_pattern',
  'tuple_pattern',
  'destructuring_pattern',
]);
const languages = new Map();
let ready;

function asset(name) {
  const url = new URL(`../../vendor/${name}`, import.meta.url);
  return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : url.href;
}
async function grammar(name) {
  ready ??= Parser.init({ locateFile: () => asset('tree-sitter.wasm') });
  await ready;
  if (!languages.has(name)) languages.set(name, Language.load(asset(`tree-sitter-${name}.wasm`)));
  return languages.get(name);
}
function sourceRange(startLine, endLine) {
  return { startLine, endLine, kind: 'source', name: '', depth: 0 };
}
function sourceLines(text) {
  let count = text.length && !text.endsWith('\n') ? 1 : 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) count++;
  return count;
}
function displayWidth(text, start = 0, end = text.length) {
  let columns = 0;
  for (let i = start; i < end;) {
    const cp = text.codePointAt(i);
    i += cp > 0xffff ? 2 : 1;
    columns +=
      cp === 9 ? 4 - (columns % 4) : cp > 127 ? 3 : cp === 13 && text.charCodeAt(i) === 10 ? 0 : 1;
  }
  return columns;
}
function addressAt(text, index, line) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  return { line, column: displayWidth(text, start, index) };
}
function previewAt(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const start = Math.max(lineStart, index - 80);
  const newline = text.indexOf('\n', index);
  const end = Math.min(newline < 0 ? text.length : newline, start + 240);
  return compactText(
    `${start > lineStart ? '…' : ''}${text.slice(start, end).replace(/\r$/, '')}${end < (newline < 0 ? text.length : newline) ? '…' : ''}`,
  );
}
function declaratorName(node) {
  for (let i = 0; node && i < MAX_DEPTH; i++) {
    if (NAME_TYPES.has(node.type)) return node;
    if (node.type === 'parenthesized_declarator') {
      let child = node.firstNamedChild;
      while (child?.type === 'ms_call_modifier') child = child.nextNamedSibling;
      node = child;
    } else node = node.childForFieldName('declarator');
  }
  return null;
}
function classify(node, inFunction) {
  const type = node.type,
    name = () => node.childForFieldName('name');
  if (FUNCTION_TYPES.has(type))
    return { kind: 'function', name: name() || declaratorName(node), emit: true };
  if (TYPE_TYPES.has(type)) return { kind: 'type', name: name(), emit: true };
  if (type === 'type_definition') return { kind: 'type', name: declaratorName(node), emit: true };
  if (type === 'impl_item')
    return { kind: 'type', name: node.childForFieldName('type'), emit: false };
  if (['namespace_definition', 'internal_module', 'module', 'mod_item'].includes(type) && name())
    return { kind: 'namespace', name: name(), emit: true };
  if (type === 'variable_declarator') {
    const value = node.childForFieldName('value');
    if (
      value &&
      ['arrow_function', 'function_expression', 'generator_function'].includes(value.type)
    )
      return { kind: 'function', name: name(), emit: true };
    if (!inFunction) return { kind: 'declaration', name: name(), emit: true };
  }
  if (!inFunction && ['declaration', 'field_declaration'].includes(type))
    return { kind: 'declaration', name: declaratorName(node), emit: true };
  if (!inFunction && ['const_item', 'static_item'].includes(type))
    return { kind: 'declaration', name: name(), emit: true };
  if (
    ['import_statement', 'import_from_statement', 'use_declaration', 'preproc_include'].includes(
      type,
    )
  )
    return { kind: 'declaration', name: null, emit: false };
  return null;
}
function trustedHeader(node, kind) {
  if (kind !== 'type' && kind !== 'namespace') return false;
  const body = node.childForFieldName('body');
  if (!body || body.isError || body.isMissing) return false;
  for (
    let child = node.firstChild;
    child && child.startIndex < body.startIndex;
    child = child.nextSibling
  )
    if (child.hasError || child.isError || child.isMissing) return false;
  return true;
}
function wholeLineComment(node, text) {
  const start = text.lastIndexOf('\n', node.startIndex - 1) + 1;
  const end = text.indexOf('\n', node.endIndex);
  return (
    /^\s*$/.test(text.slice(start, node.startIndex)) &&
    /^\s*$/.test(text.slice(node.endIndex, end < 0 ? text.length : end))
  );
}

// A min-heap keeps result memory proportional to the requested result limit.
function pushHeap(heap, item, compare) {
  let i = heap.length;
  heap.push(item);
  while (i) {
    const parent = (i - 1) >> 1;
    if (compare(heap[parent], item) <= 0) break;
    heap[i] = heap[parent];
    i = parent;
  }
  heap[i] = item;
}
function popHeap(heap, compare) {
  const first = heap[0],
    item = heap.pop();
  if (!heap.length) return first;
  let i = 0;
  while (2 * i + 1 < heap.length) {
    let child = 2 * i + 1;
    if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) < 0) child++;
    if (compare(item, heap[child]) <= 0) break;
    heap[i] = heap[child];
    i = child;
  }
  heap[i] = item;
  return first;
}
function partition(candidates, lines) {
  const events = candidates.flatMap((s, index) => [
    { line: s.startLine, index, start: true },
    { line: s.endLine, index, start: false },
  ]);
  events.push({ line: lines, index: -1, start: false });
  events.sort((a, b) => a.line - b.line);
  const active = new Set(),
    heap = [],
    segments = [];
  const compare = (a, b) => candidates[b].depth - candidates[a].depth || a - b;
  let previous = 0,
    previousOwner = -2;
  for (let i = 0; i < events.length;) {
    const line = events[i].line;
    while (heap.length && !active.has(heap[0])) popHeap(heap, compare);
    const owner = heap.length ? heap[0] : -1;
    if (line > previous) {
      if (owner === previousOwner) segments.at(-1).endLine = line;
      else
        segments.push(
          owner < 0
            ? sourceRange(previous, line)
            : { ...candidates[owner], startLine: previous, endLine: line },
        );
      previous = line;
      previousOwner = owner;
      if (segments.length > MAX_RECORDS) return null;
    }
    do {
      const event = events[i++];
      if (event.index >= 0) {
        if (event.start) {
          active.add(event.index);
          pushHeap(heap, event.index, compare);
        } else active.delete(event.index);
      }
    } while (i < events.length && events[i].line === line);
  }
  return segments;
}

/** Coordinates are original zero-based lines and conservative display columns:
 * tabs advance to a four-column stop; each non-ASCII Unicode scalar uses 3 cells.
 * The definition address is the name token, while segments cover syntax scopes.
 */
export async function extractSymbols({ id, path, text, revision }) {
  if (typeof text !== 'string' || typeof path !== 'string')
    throw new TypeError('Expected a document path and source text');
  const basename = path.slice(path.lastIndexOf('/') + 1),
    dot = basename.lastIndexOf('.');
  const extension = dot > 0 ? basename.slice(dot + 1).toLowerCase() : '';
  const lines = sourceLines(text),
    name = Object.hasOwn(GRAMMARS, extension) ? GRAMMARS[extension] : null;
  const fallback = lines ? [sourceRange(0, lines)] : [];
  const report = {
    symbols: [],
    segments: fallback,
    parser: name ? `tree-sitter-${name}:wasms@0.1.13+definitions@1` : 'source',
    complete: false,
    state: 'unsupported',
    reason: 'No bundled grammar for this file type',
  };
  if (!name) return report;
  if (
    text.length > MAX_PARSE_BYTES ||
    text.includes('\0') ||
    ENCODER.encode(text).length > MAX_PARSE_BYTES
  )
    return {
      ...report,
      state: 'limited',
      reason: 'Syntax parsing is limited to 2 MiB of text without NUL',
    };
  let language;
  try {
    language = await grammar(name);
  } catch {
    return { ...report, state: 'unavailable', reason: 'Bundled syntax parser could not be loaded' };
  }
  let parser, tree, cursor;
  const deadline = performance.now() + PARSE_MS;
  try {
    parser = new Parser();
    parser.setLanguage(language);
    // The 0.25.10 JS timeout wrapper has an i64/BigInt mismatch on current Node;
    // the runtime's supported progress callback enforces the same parse deadline.
    tree = parser.parse(text, null, { progressCallback: () => performance.now() >= deadline });
    if (!tree)
      return { ...report, state: 'limited', reason: 'Syntax parsing reached its time budget' };
    report.state = tree.rootNode.hasError ? 'partial' : 'parsed';
    report.reason = tree.rootNode.hasError ? 'Syntax errors limit trustworthy declarations' : '';
    const candidates = [],
      stack = [];
    let context = { scope: '', inFunction: false, depth: 0 },
      visited = 0;
    cursor = tree.walk();
    walk: while (true) {
      if (
        ++visited > 200000 ||
        performance.now() >= deadline ||
        report.symbols.length >= MAX_RECORDS ||
        candidates.length >= MAX_RECORDS
      ) {
        report.state = 'limited';
        report.reason = 'Syntax extraction reached a resource budget';
        break;
      }
      const node = cursor.currentNode;
      let next = context,
        descend = !node.isError && !node.isMissing;
      if (!descend && /['"`/]/.test(text.slice(node.startIndex, node.endIndex))) {
        report.state = 'partial';
        report.reason = 'Ambiguous string or comment recovery';
        break;
      }
      if (descend && node.isNamed) {
        let declaration = classify(node, context.inFunction);
        if (
          !declaration &&
          ['comment', 'line_comment', 'block_comment'].includes(node.type) &&
          wholeLineComment(node, text)
        )
          declaration = { kind: 'comment', name: null, emit: false };
        if (declaration) {
          const { kind, name: token, emit } = declaration;
          if (node.hasError && !trustedHeader(node, kind)) {
            descend = false;
            report.state = 'partial';
          } else {
            const validName = token && !DESTRUCTURING.has(token.type);
            const symbolName = validName
              ? compactText(text.slice(token.startIndex, token.endIndex))
              : '';
            if (symbolName.length > 512 || context.scope.length > 2048) {
              descend = false;
              report.state = 'limited';
              report.reason = 'Declaration name or scope exceeds its budget';
            } else {
              if (validName && emit) {
                const from = addressAt(text, token.startIndex, token.startPosition.row),
                  to = addressAt(text, token.endIndex, token.endPosition.row);
                const body = node.childForFieldName('body');
                report.symbols.push({
                  id,
                  path,
                  revision,
                  name: symbolName,
                  kind: 'symbol',
                  symbolKind: kind,
                  scope: context.scope,
                  signature: compactText(
                    text
                      .slice(
                        node.startIndex,
                        Math.min(body?.startIndex ?? node.endIndex, node.startIndex + 1024),
                      )
                      .trim(),
                  ),
                  line: from.line,
                  column: from.column,
                  endLine: to.line,
                  endColumn: to.column,
                  preview: previewAt(text, token.startIndex),
                });
              }
              if (!node.hasError) {
                const startLine = Math.min(node.startPosition.row, lines),
                  end = node.endPosition,
                  endLine = Math.min(end.row + Number(end.column > 0), lines);
                if (startLine < endLine)
                  candidates.push({
                    startLine,
                    endLine,
                    kind,
                    name: symbolName,
                    depth: context.depth,
                  });
              }
              if (CONTAINERS.has(kind))
                next = {
                  scope: symbolName
                    ? context.scope
                      ? `${context.scope}::${symbolName}`
                      : symbolName
                    : context.scope,
                  inFunction: context.inFunction || kind === 'function',
                  depth: context.depth + 1,
                };
            }
          }
        }
      }
      if (descend && cursor.gotoFirstChild()) {
        if (stack.length >= MAX_DEPTH) {
          report.state = 'limited';
          report.reason = 'Syntax nesting exceeds its budget';
          break;
        }
        stack.push(context);
        context = next;
        continue;
      }
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) break walk;
        context = stack.pop();
      }
    }
    const segments = partition(candidates, lines);
    if (segments) report.segments = segments;
    else {
      report.state = 'limited';
      report.reason = 'Syntax partition exceeds its budget';
    }
    report.complete = report.state === 'parsed';
    return report;
  } catch {
    return {
      ...report,
      complete: false,
      state: 'unavailable',
      reason: 'Syntax parser failed for this document',
    };
  } finally {
    cursor?.delete();
    tree?.delete();
    parser?.delete();
  }
}

function validateQuery(query, limit) {
  if (typeof query !== 'string' || query.length > 1024 || query.includes('\0'))
    throw new Error('Search query must be at most 1024 characters without NUL');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error('Search limit must be 1–200');
}
function compareHits(a, b) {
  return (
    a.score - b.score ||
    (a.path === b.path ? 0 : a.path < b.path ? 1 : -1) ||
    b.line - a.line ||
    b.column - a.column
  );
}
function retain(heap, item, limit) {
  if (heap.length >= limit) {
    if (compareHits(item, heap[0]) <= 0) return;
    popHeap(heap, compareHits);
  }
  pushHeap(heap, item, compareHits);
}
function searchReport(results = [], total = 0, complete = true) {
  return {
    results,
    total,
    complete,
    status: complete ? 'complete' : 'partial',
    truncated: total > results.length,
    totalIsLowerBound: !complete,
    matchedFiles: [],
    matchedFilesTruncated: false,
  };
}

/** Complete describes the scanned symbol index, not syntax coverage. The caller
 * attaches project parser coverage, including unsupported and partial documents. */
export function searchSymbols(symbols, query, limit = 40) {
  validateQuery(query, limit);
  const needle = query.trim().toLowerCase(),
    heap = [],
    counts = new Map();
  if (!needle) return searchReport();
  let total = 0,
    scanned = 0,
    complete = true,
    filesTruncated = false;
  for (const symbol of symbols) {
    if (++scanned > 1000000) {
      complete = false;
      break;
    }
    const folded = symbol.name.toLowerCase(),
      at = folded.indexOf(needle);
    if (at < 0) continue;
    total++;
    if (counts.has(symbol.id) || counts.size < 25000)
      counts.set(symbol.id, (counts.get(symbol.id) || 0) + 1);
    else filesTruncated = true;
    const score = folded === needle ? 12000 : at === 0 ? 11000 : 9000;
    retain(heap, { ...symbol, score }, limit);
  }
  const report = searchReport(
    heap.sort((a, b) => -compareHits(a, b)),
    total,
    complete,
  );
  report.matchedFiles = Array.from(counts, ([id, count]) => ({ id, count }));
  report.matchedFilesTruncated = filesTruncated;
  return report;
}

const yieldControl = () =>
  globalThis.scheduler?.yield
    ? globalThis.scheduler.yield()
    : new Promise((resolve) => setTimeout(resolve, 0));
function cancelled(signal) {
  if (signal?.aborted) throw new DOMException('Search cancelled', 'AbortError');
}

// JS lowercase can expand scalars (İ -> i + combining dot). Map only those
// chunks whose UTF-16 length changes, so returned addresses always refer to source.
function foldChunk(text) {
  const folded = text.toLowerCase();
  if (folded.length === text.length) return { folded, at: (index) => index };
  const map = new Uint32Array(folded.length + 1);
  let source = 0,
    target = 0;
  for (const scalar of text) {
    const lower = scalar.toLowerCase();
    for (let i = 0; i < lower.length; i++) map[target++] = source;
    source += scalar.length;
  }
  map[target] = source;
  return {
    folded,
    at: (index, end = false) => {
      // A hit ending inside an expanded scalar still targets that whole scalar.
      if (end && index > 0) while (index < map.length - 1 && map[index] === map[index - 1]) index++;
      return map[index];
    },
  };
}

/** Scan one stored document at a time; literal, case-insensitive substrings only.
 * Cancellation rejects with AbortError. Other failed/mismatched reads contribute
 * explicit partial coverage. Counts become lower bounds when a budget is reached.
 */
export async function searchText(
  metas,
  readDocument,
  query,
  { limit = 40, signal, onProgress } = {},
) {
  validateQuery(query, limit);
  cancelled(signal);
  const report = { ...searchReport(), scannedDocuments: 0, skippedDocuments: 0, scannedBytes: 0 };
  const needle = query.toLowerCase();
  if (!needle) return report;
  const deadline = performance.now() + 3000,
    CHUNK = 65536;
  let limited = false;
  for (const meta of metas) {
    cancelled(signal);
    if (
      performance.now() >= deadline ||
      report.scannedDocuments + report.skippedDocuments >= 25000 ||
      report.scannedBytes >= 128 * 1024 * 1024
    ) {
      limited = true;
      break;
    }
    let document;
    try {
      document = await readDocument(meta.id);
    } catch (error) {
      cancelled(signal);
      if (error?.name === 'AbortError') throw error;
      report.skippedDocuments++;
      continue;
    }
    cancelled(signal);
    if (
      !document ||
      typeof document.text !== 'string' ||
      document.id !== meta.id ||
      (meta.revision != null && document.revision !== meta.revision) ||
      (meta.path != null && document.path !== meta.path)
    ) {
      report.skippedDocuments++;
      continue;
    }
    const text = document.text;
    if (text.length > 16 * 1024 * 1024 || text.includes('\0')) {
      report.skippedDocuments++;
      continue;
    }
    const bytes = ENCODER.encode(text).length;
    if (bytes > 16 * 1024 * 1024) {
      report.skippedDocuments++;
      continue;
    }
    if (report.scannedBytes + bytes > 128 * 1024 * 1024) {
      limited = true;
      break;
    }
    report.scannedBytes += bytes;
    let count = 0,
      coordinateIndex = 0,
      line = 0,
      column = 0,
      nextMatchOffset = 0;
    function coordinate(index) {
      while (coordinateIndex < index) {
        const cp = text.codePointAt(coordinateIndex);
        coordinateIndex += cp > 0xffff ? 2 : 1;
        if (cp === 10) {
          line++;
          column = 0;
        } else
          column +=
            cp === 9
              ? 4 - (column % 4)
              : cp > 127
                ? 3
                : cp === 13 && text.charCodeAt(coordinateIndex) === 10
                  ? 0
                  : 1;
      }
      return { line, column };
    }
    for (let offset = 0; offset < text.length;) {
      let boundary = Math.min(offset + CHUNK, text.length);
      if (
        boundary < text.length &&
        text.charCodeAt(boundary - 1) >= 0xd800 &&
        text.charCodeAt(boundary - 1) <= 0xdbff
      )
        boundary--;
      const { folded, at } = foldChunk(
        text.slice(offset, Math.min(text.length, boundary + needle.length * 2)),
      );
      let from =
        nextMatchOffset > offset ? text.slice(offset, nextMatchOffset).toLowerCase().length : 0;
      while (true) {
        const found = folded.indexOf(needle, from);
        if (found < 0) break;
        const start = offset + at(found),
          end = offset + at(found + needle.length, true);
        if (start >= boundary) break;
        from = found + Math.max(1, needle.length);
        if (end <= start) continue;
        nextMatchOffset = end;
        count++;
        report.total++;
        if (report.results.length < limit) {
          const a = coordinate(start),
            b = coordinate(end);
          report.results.push({
            id: document.id,
            path: document.path,
            revision: document.revision,
            name: compactText(text.slice(start, end)),
            kind: 'text',
            symbolKind: '',
            line: a.line,
            column: a.column,
            endLine: b.line,
            endColumn: b.column,
            preview: previewAt(text, start),
            score: 7000,
          });
        }
        if (report.total >= 100000) {
          limited = true;
          break;
        }
      }
      if (limited) break;
      offset = boundary;
      await yieldControl();
      cancelled(signal);
      if (performance.now() >= deadline) {
        limited = true;
        break;
      }
    }
    report.scannedDocuments++;
    if (count) report.matchedFiles.push({ id: document.id, count });
    onProgress?.({
      scannedDocuments: report.scannedDocuments,
      skippedDocuments: report.skippedDocuments,
      scannedBytes: report.scannedBytes,
      total: report.total,
    });
    if (limited) break;
  }
  cancelled(signal);
  report.complete = !limited && !report.skippedDocuments;
  report.status = report.complete ? 'complete' : 'partial';
  report.totalIsLowerBound = !report.complete;
  report.truncated = report.total > report.results.length;
  return report;
}
