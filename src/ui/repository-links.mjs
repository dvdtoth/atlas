import { parseRepository } from '../import/github-import.mjs';
const encode = (part) =>
  encodeURIComponent(part).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
function safePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !/[\\\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every((p) => p && p !== '.' && p !== '..')
  );
}
export function githubSourceURL(manifest, path, line = null) {
  try {
    if (!/^[0-9a-f]{40}$/i.test(manifest.commit) || !safePath(path)) return null;
    const repo = parseRepository(manifest.sourceRepo);
    if (line != null && (!Number.isSafeInteger(line) || line < 0)) return null;
    return `https://github.com/${repo.owner}/${repo.name}/blob/${manifest.commit}/${path.split('/').map(encode).join('/')}${line == null ? '' : '#L' + (line + 1)}`;
  } catch {
    return null;
  }
}
export async function sourceMenuTarget(manifest, address, readDocument) {
  let line = address.line ?? null;
  if (line != null && address.display) {
    const page = await readDocument({ id: address.id, start: line, count: 1, display: 1 });
    line = page.lineMap?.[0];
    if (!Number.isSafeInteger(line) || line < 0)
      throw Error('Could not resolve the original source line.');
  }
  return {
    line,
    url: githubSourceURL(manifest, address.path, line),
    fileURL: githubSourceURL(manifest, address.path),
  };
}
export function githubArchiveURL(input, ref = 'HEAD') {
  const repo = parseRepository(input);
  ref = ref.trim() || 'HEAD';
  if (!safePath(ref) || /[?#:]/.test(ref) || ref.length > 200)
    throw Error('Enter a valid branch, tag, or commit for the ZIP download.');
  return `https://github.com/${repo.owner}/${repo.name}/archive/${ref.split('/').map(encode).join('/')}.zip`;
}
