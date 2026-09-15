// This public routing ID belongs only to the official GitHub Pages deployment.
export function pagesAnalyticsModule(env) {
  if (
    env.ATLAS_DEPLOYMENT !== 'github-pages' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== 'dvdtoth/atlas' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
  )
    return null;

  // A copied deployment artifact must also stay silent on another host or path.
  return `const hosted = globalThis.location?.origin === 'https://dvdtoth.github.io'
  && globalThis.location?.pathname?.startsWith('/atlas/');
export const analytics = Object.freeze(hosted ? {
  endpoint: 'https://cloud.umami.is/api/send',
  website: '639a9cc5-8e01-4b7e-bb63-6ac31a07bb3a',
} : { endpoint: '', website: '' });
`;
}
