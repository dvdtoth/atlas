import { indexDocument, documentTransfers } from './index-document.mjs';
import { serveWorker } from '../shared/worker-rpc.mjs';

serveWorker(
  (method, file, options) => {
    if (method !== 'index') throw Error('Unknown indexing operation');
    return indexDocument(file, options);
  },
  { transfer: (_method, value) => documentTransfers(value) },
);
