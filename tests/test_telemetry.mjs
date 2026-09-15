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
  ])
    await createTelemetry({ ...options, fetch }).track('import_started');
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
