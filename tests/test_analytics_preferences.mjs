import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyticsPreferences, createTelemetry } from '../src/shared/telemetry.mjs';

const usageKey = 'atlas.analytics.consent';
const repoKey = 'atlas.analytics.repositories';
function fixture(defaultShare = true) {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const preferences = createAnalyticsPreferences({ defaultShare, storage: () => storage });
  return { values, storage, preferences };
}

test('sharing defaults require deployment configuration and do not persist an implied choice', () => {
  for (const enabled of [false, true]) {
    const { values, preferences } = fixture(enabled);
    assert.equal(preferences.usage(), enabled);
    assert.equal(preferences.repositories(), enabled);
    assert.equal(values.size, 0);
  }
});

test('saved choices override defaults and changes from other tabs are read immediately', () => {
  const { values, preferences } = fixture();
  for (const choice of ['no', '', 'invalid', 'yes']) {
    values.set(usageKey, choice);
    values.set(repoKey, choice);
    assert.equal(preferences.usage(), choice === 'yes');
    assert.equal(preferences.repositories(), choice === 'yes');
  }
  assert.equal(values.size, 2);
});

test('usage opt-out also disables repository sharing, which requires enabled usage', () => {
  const { values, preferences } = fixture();
  preferences.setUsage(false);
  preferences.setRepositories(true);
  assert.equal(preferences.usage(), false);
  assert.equal(preferences.repositories(), false);
  assert.equal(values.get(usageKey), 'no');
  assert.equal(values.get(repoKey), 'no');
  preferences.setUsage(true);
  assert.equal(preferences.repositories(), false, 'a saved repository opt-out stays off');
  preferences.setRepositories(true);
  assert.equal(preferences.repositories(), true);
});

test('unreadable preferences stay off, and failed writes cannot undo a current-page opt-out', () => {
  const unreadable = createAnalyticsPreferences({
    defaultShare: true,
    storage: () => {
      throw Error('storage blocked');
    },
  });
  assert.equal(unreadable.usage(), false);
  assert.equal(unreadable.repositories(), false);
  const { storage, preferences } = fixture();
  storage.setItem = () => {
    throw Error('storage full');
  };
  preferences.setUsage(false);
  assert.equal(preferences.usage(), false);
  assert.equal(preferences.repositories(), false);
  preferences.setUsage(true);
  assert.equal(preferences.usage(), false, 'failed opt-in writes also stay off');
});

test('browser privacy signals override default sharing before pageviews or repository events', async () => {
  const { preferences } = fixture();
  const config = {
    endpoint: 'https://analytics.example/api/send',
    website: '00000000-0000-4000-8000-000000000001',
  };
  for (const navigator of [
    {},
    { doNotTrack: '0' },
    { doNotTrack: '1' },
    { globalPrivacyControl: true },
  ]) {
    const calls = [];
    const telemetry = createTelemetry({
      config,
      navigator,
      getConsent: preferences.usage,
      getRepositoryConsent: preferences.repositories,
      fetch: async (_, options) => {
        calls.push(JSON.parse(options.body));
        return { ok: true };
      },
    });
    await telemetry.pageview();
    await telemetry.track('repository_viewed', { source: 'github', repo: 'dvdtoth/atlas' });
    const blocked = navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true;
    assert.equal(telemetry.allowed, !blocked);
    assert.equal(calls.length, blocked ? 0 : 2);
  }
});
