import { analyzeDocument } from '../index/client-index.mjs';
import { extractSymbols } from '../index/client-search.mjs';

export async function indexDocument(file, { extract = extractSymbols, signal } = {}) {
  signal?.throwIfAborted();
  const doc = analyzeDocument(file),
    structure = await extract(doc);
  signal?.throwIfAborted();
  doc.structure = {
    parser: structure.parser,
    complete: structure.complete,
    segments: structure.segments,
    state: structure.state,
    reason: structure.reason,
  };
  return {
    doc,
    symbols: structure.symbols,
    state: structure.state || (structure.complete ? 'parsed' : 'partial'),
  };
}

export function documentTransfers({ doc }) {
  return [
    ...new Set(
      [doc.lineOffsets, doc.rawProfile, doc.displayProfile, doc.wraps]
        .filter(Boolean)
        .map((v) => v.buffer),
    ),
  ];
}
