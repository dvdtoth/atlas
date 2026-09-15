import { analytics } from './config.mjs';

const EVENTS = new Set([
  'app_opened',
  'import_started',
  'import_ready',
  'import_failed',
  'import_cancelled',
  'cache_opened',
  'viewer_ready',
  'view_changed',
  'search_used',
  'result_selected',
]);
const ENUMS = {
  mode: ['2d', '3d', 'all', 'files', 'symbols', 'text'],
  source: ['github', 'folder', 'zip'],
  reason: ['network', 'storage', 'limit', 'unsupported', 'unknown'],
};
const NUMBERS = new Set(['files', 'bytes', 'seconds', 'results']);
function validConfig(config) {
  try {
    return (
      /^https:$/.test(new URL(config.endpoint).protocol) &&
      /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(config.website)
    );
  } catch {
    return false;
  }
}
function numberBucket(key, value) {
  if (key === 'bytes') return value <= 0 ? 0 : 2 ** Math.ceil(Math.log2(value));
  if (key === 'files')
    return value < 100 ? Math.ceil(value / 10) * 10 : Math.round(value / 1000) * 1000;
  return Math.round(value);
}
export function eventPayload(name, properties = {}, config = analytics, hostname = '') {
  if (!EVENTS.has(name) || !validConfig(config)) return null;
  const data = {};
  for (const [key, value] of Object.entries(properties)) {
    if (NUMBERS.has(key) && Number.isFinite(value) && value >= 0 && value < 1e13)
      data[key] = numberBucket(key, value);
    else if (ENUMS[key]?.includes(value)) data[key] = value;
  }
  return {
    type: 'event',
    payload: {
      website: config.website,
      hostname,
      url: '/',
      referrer: '',
      title: 'Atlas',
      name,
      data,
    },
  };
}
export function createTelemetry({
  config = analytics,
  consent = false,
  getConsent = null,
  navigator: nav = globalThis.navigator || {},
  hostname = globalThis.location?.hostname || '',
  fetch: send = globalThis.fetch?.bind(globalThis),
} = {}) {
  let optedIn = consent,
    last = 0,
    sent = 0;
  const privacy = () => nav.globalPrivacyControl === true || nav.doNotTrack === '1';
  return {
    get configured() {
      return validConfig(config);
    },
    get allowed() {
      return (getConsent ? getConsent() : optedIn) && !privacy() && validConfig(config);
    },
    get privacyBlocked() {
      return privacy();
    },
    setConsent(value) {
      optedIn = value === true;
    },
    async track(name, properties = {}) {
      if (!this.allowed || !send) return false;
      const payload = eventPayload(name, properties, config, hostname);
      if (!payload) return false;
      // Prevent accidental render-loop analytics. No retry queue or persisted tracking ID.
      const now = Date.now();
      if (now - last > 60_000) {
        last = now;
        sent = 0;
      }
      if (++sent > 30) return false;
      try {
        return (
          await send(config.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            keepalive: true,
            signal: AbortSignal.timeout(5000),
          })
        ).ok;
      } catch {
        return false;
      }
    },
  };
}
export function savedConsent() {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem('atlas.analytics.consent') === 'yes';
  } catch {
    return false;
  }
}
export const telemetry = createTelemetry({ consent: savedConsent(), getConsent: savedConsent });
export function setAnalyticsConsent(value) {
  telemetry.setConsent(value);
  try {
    localStorage.setItem('atlas.analytics.consent', value ? 'yes' : 'no');
  } catch {}
}
