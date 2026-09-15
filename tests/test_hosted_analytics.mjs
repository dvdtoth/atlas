import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { analytics } from '../src/shared/config.mjs';
import { pagesAnalyticsModule } from '../scripts/pages-analytics.mjs';

const production = {
  ATLAS_DEPLOYMENT: 'github-pages',
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'dvdtoth/atlas',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'push',
};

test('source checkout has no analytics destination', () => {
  assert.deepEqual(analytics, { endpoint: '', website: '' });
});

test('only the upstream main Pages build receives the hosted configuration', () => {
  for (const env of [
    {},
    { ...production, ATLAS_DEPLOYMENT: '' },
    { ...production, GITHUB_ACTIONS: 'false' },
    { ...production, GITHUB_REPOSITORY: 'example/atlas' },
    { ...production, GITHUB_REF: 'refs/heads/preview' },
    { ...production, GITHUB_EVENT_NAME: 'pull_request' },
    { ...production, GITHUB_EVENT_NAME: 'pull_request_target' },
  ])
    assert.equal(pagesAnalyticsModule(env), null);
  assert.ok(pagesAnalyticsModule(production));
  assert.ok(pagesAnalyticsModule({ ...production, GITHUB_EVENT_NAME: 'workflow_dispatch' }));
});

test('copied Pages artifacts stay disabled outside the exact production origin and path', () => {
  const source = pagesAnalyticsModule(production);
  const evaluate = (url) =>
    vm.runInNewContext(
      source.replace('export const analytics', 'const analytics') + '\nanalytics;',
      { location: url ? new URL(url) : undefined },
    );
  for (const url of [
    undefined,
    'http://127.0.0.1:8766/atlas/',
    'https://example.github.io/atlas/',
    'https://atlas.example/',
    'https://dvdtoth.github.io/',
    'https://dvdtoth.github.io/atlas-copy/',
    'https://dvdtoth.github.io/another/atlas/',
    'https://dvdtoth.github.io.evil.invalid/atlas/',
    'https://sub.dvdtoth.github.io/atlas/',
    'http://dvdtoth.github.io/atlas/',
    'https://dvdtoth.github.io:8443/atlas/',
    'file:///atlas/index.html',
  ]) {
    const config = evaluate(url);
    assert.equal(config.endpoint, '', String(url));
    assert.equal(config.website, '', String(url));
  }
  for (const path of ['', 'index.html', 'viewer.html?project=local-id', 'privacy.html']) {
    const config = evaluate('https://dvdtoth.github.io/atlas/' + path);
    assert.equal(config.endpoint, 'https://cloud.umami.is/api/send');
    assert.equal(config.website, '639a9cc5-8e01-4b7e-bb63-6ac31a07bb3a');
  }
});
