export const GEOMETRY_BUDGET = 256 * 1048576;
export function foldCount(lines, panels) {
  if (!lines) return 0;
  const chunk = Math.max(96, Math.ceil(lines / 2048)),
    q = Math.floor(lines / panels),
    r = lines % panels;
  return (panels - r) * Math.ceil(q / chunk) + r * Math.ceil((q + 1) / chunk);
}
export function assertGeometryBudget(files, folds, folders) {
  const bytes = (files + folds + folders) * 100;
  if (!Number.isSafeInteger(bytes) || bytes > GEOMETRY_BUDGET)
    throw Error(
      'This repository exceeds the 256 MiB browser geometry budget. Choose a smaller source folder.',
    );
  return bytes;
}
