import { WorkerRPC } from '../shared/worker-rpc.mjs';
export const projectId = new URLSearchParams(location.search).get('project');
const rpc = new WorkerRPC(new URL('../import/project-worker.mjs', import.meta.url));
export const openSnapshot = () => {
  if (!projectId) throw Error('Choose a repository from the Atlas library first.');
  return rpc.request('open', { projectId });
};
export function localRequest(url, signal) {
  const parsed = new URL(url, 'https://local.invalid');
  const method = parsed.pathname.replace(/^\/api\//, '');
  if (
    ![
      'document',
      'address',
      'selection',
      'segments',
      'search',
      'suggest',
      'search-status',
    ].includes(method)
  )
    return Promise.reject(Error('Unknown local source request'));
  return rpc.request(method, Object.fromEntries(parsed.searchParams), { signal });
}
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) rpc.close();
});
