import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetry, eventPayload } from '../src/shared/telemetry.mjs';

const config = {
  endpoint: 'https://cloud.umami.is/api/send',
  website: '00000000-0000-4000-8000-000000000001',
};
test('telemetry sends no event before consent, when unconfigured or privacy signals enabled', async () => {
  const calls = [];
  const fetch = async (...args) => {
    calls.push(args);
    return { ok: true };
  };
  for (const options of [
    { config },
    { config, consent: true, navigator: { globalPrivacyControl: true } },
    { config, consent: true, navigator: { doNotTrack: '1' } },
    { config: {}, consent: true },
  ]) {
    const t = createTelemetry({ ...options, fetch });
    await t.track('import_started');
    await t.pageview();
  }
  assert.equal(calls.length, 0);
});
test('events omit source identity, free text, URLs and referrers even if callers pass them', () => {
  const data = eventPayload(
    'import_ready',
    {
      files: 2134,
      bytes: 912343,
      seconds: 12.25,
      repo: 'secret/repo',
      query: 'password',
      path: 'keys.js',
      source: 'secret',
      error: 'secret stack',
      mode: 'arbitrary secret',
    },
    config,
    'atlas.example',
  );
  assert.equal(data.payload.url, '/');
  assert.equal(data.payload.referrer, '');
  assert.deepEqual(data.payload.data, { files: 2000, bytes: 1048576, seconds: 12 });
  assert.equal(JSON.stringify(data).includes('secret'), false);
  assert.equal(eventPayload('private_symbol_name', {}, config, 'atlas.example'), null);
});
test('opt-in collection uses omitted credentials and no-referrer with failures swallowed', async () => {
  let request;
  const t = createTelemetry({
    config,
    consent: true,
    navigator: {},
    hostname: 'atlas.example',
    fetch: async (url, options) => {
      request = { url, options };
      throw Error('offline');
    },
  });
  assert.equal(await t.track('view_changed', { mode: '3d' }), false);
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.deepEqual(JSON.parse(request.options.body).payload.data, { mode: '3d' });
  t.setConsent(false);
  request = null;
  await t.track('view_changed', { mode: '2d' });
  assert.equal(request, null);
});
test('withdrawal in another tab is consulted before every event', async () => {
  let consent = true,
    sent = 0;
  const t = createTelemetry({
    config,
    consent: true,
    getConsent: () => consent,
    navigator: {},
    fetch: async () => {
      sent++;
      return { ok: true };
    },
  });
  await t.track('app_opened');
  consent = false;
  await t.track('search_used', { mode: 'symbols' });
  assert.equal(sent, 1);
  assert.equal(t.allowed, false);
});

test('pageviews use fixed app paths and titles without project or source information', async () => {
  const calls = [];
  const t = createTelemetry({
    config,
    consent: true,
    navigator: {},
    page: 'viewer',
    hostname: 'atlas.example',
    fetch: async (_, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true };
    },
  });
  await t.pageview();
  await t.pageview();
  await t.track('viewer_ready', { url: '?project=private', title: 'Private repository' });
  assert.equal(calls.length, 2, 'one pageview per document, plus the ready event');
  assert.equal(calls[0].payload.url, '/viewer.html');
  assert.equal(calls[0].payload.title, 'Atlas · Viewer');
  assert.equal('name' in calls[0].payload, false);
  assert.equal(calls[1].payload.url, '/viewer.html');
  assert.equal(JSON.stringify(calls).includes('private'), false);
});

test('repository identities need separate current consent and are limited to public GitHub events', async () => {
  let consent = false;
  const calls = [];
  const t = createTelemetry({
    config,
    consent: true,
    navigator: {},
    getRepositoryConsent: () => consent,
    fetch: async (_, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true };
    },
  });
  await t.track('repository_viewed', { source: 'github', repo: 'dvdtoth/atlas' });
  assert.equal(calls.length, 0);
  consent = true;
  for (const source of ['zip', 'folder'])
    await t.track('repository_viewed', { source, repo: 'private/project' });
  for (const repo of ['../secret', 'https://github.com/a/b', 'a/b?secret', 'a/b/c', 'a/.', 'a/..'])
    await t.track('repository_viewed', { source: 'github', repo });
  assert.equal(calls.length, 0);
  await t.track('repository_viewed', { source: 'github', repo: 'dvdtoth/atlas', query: 'secret' });
  assert.deepEqual(calls[0].payload.data, { source: 'github', repo: 'dvdtoth/atlas' });
  await t.track('import_ready', { repo: 'private/project', source: 'github' });
  assert.equal('repo' in calls[1].payload.data, false);
  consent = false;
  await t.track('repository_viewed', { source: 'github', repo: 'dvdtoth/atlas' });
  assert.equal(calls.length, 2);
});

test('search usage is bounded per mode without starving import events', async () => {
  const calls = [];
  let now = 0;
  const t = createTelemetry({
    config,
    consent: true,
    navigator: {},
    now: () => now,
    fetch: async (_, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true };
    },
  });
  for (let i = 0; i < 100; i++) await t.track('search_used', { mode: 'symbols', results: i });
  await t.track('search_used', { mode: 'files', results: 10 });
  await t.track('import_ready', { files: 215 });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].payload.data.files, 300, 'small projects must not round to zero');
  now = 60_000;
  await t.track('search_used', { mode: 'symbols', results: 3 });
  assert.equal(calls.length, 4);
});
