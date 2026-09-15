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
  'repository_viewed',
  'github_clicked',
]);
const PAGES = {
  library: { url: '/', title: 'Atlas' },
  viewer: { url: '/viewer.html', title: 'Atlas · Viewer' },
  privacy: { url: '/privacy.html', title: 'Atlas · Privacy' },
};
const ENUMS = {
  mode: ['2d', '3d', 'all', 'files', 'symbols', 'text'],
  source: ['github', 'folder', 'zip'],
  reason: ['network', 'storage', 'limit', 'unsupported', 'unknown'],
  cache: ['hit', 'miss'],
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
    return value < 100
      ? Math.ceil(value / 10) * 10
      : value < 1000
        ? Math.ceil(value / 100) * 100
        : Math.round(value / 1000) * 1000;
  return Math.round(value);
}
export function eventPayload(
  name,
  properties = {},
  config = analytics,
  hostname = '',
  { page = 'library', repositoryConsent = false } = {},
) {
  if ((name !== null && !EVENTS.has(name)) || !validConfig(config) || !Object.hasOwn(PAGES, page))
    return null;
  // Only the dedicated event can carry an identity, with repository sharing enabled.
  if (
    name === 'repository_viewed' &&
    (!repositoryConsent ||
      properties.source !== 'github' ||
      typeof properties.repo !== 'string' ||
      !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]{1,100}$/i.test(properties.repo) ||
      ['.', '..'].includes(properties.repo.split('/')[1]))
  )
    return null;
  const data = {};
  for (const [key, value] of Object.entries(properties)) {
    if (NUMBERS.has(key) && Number.isFinite(value) && value >= 0 && value < 1e13)
      data[key] = numberBucket(key, value);
    else if (Object.hasOwn(ENUMS, key) && ENUMS[key].includes(value)) data[key] = value;
  }
  if (name === 'repository_viewed') data.repo = properties.repo.toLowerCase();
  return {
    type: 'event',
    payload: {
      website: config.website,
      hostname,
      ...PAGES[page],
      referrer: '',
      ...(name === null ? {} : { name, data }),
    },
  };
}
export function createTelemetry({
  config = analytics,
  consent = false,
  getConsent = null,
  getRepositoryConsent = () => false,
  page = 'library',
  now = () => Date.now(),
  navigator: nav = globalThis.navigator || {},
  hostname = globalThis.location?.hostname || '',
  fetch: send = globalThis.fetch?.bind(globalThis),
} = {}) {
  let optedIn = consent,
    last = -Infinity,
    sent = 0,
    pageviewSent = false;
  const recent = new Map();
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
    async pageview() {
      if (pageviewSent || !this.allowed || !send) return false;
      pageviewSent = true;
      return this.track(null);
    },
    async track(name, properties = {}) {
      if (!this.allowed || !send) return false;
      const payload = eventPayload(name, properties, config, hostname, {
        page,
        repositoryConsent: getRepositoryConsent() === true,
      });
      if (!payload) return false;
      // Prevent accidental render-loop analytics. No retry queue or persisted tracking ID.
      const time = now();
      // Suggestions run on every edit. Measure engagement at most once per mode/minute.
      const key = name === 'search_used' ? `${name}:${payload.payload.data.mode || 'all'}` : null;
      if (key && time - (recent.get(key) ?? -Infinity) < 60_000) return false;
      if (time - last >= 60_000) {
        last = time;
        sent = 0;
      }
      if (++sent > 30) return false;
      if (key) recent.set(key, time);
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
export function createAnalyticsPreferences({
  defaultShare = false,
  storage = () => (typeof window === 'undefined' ? null : window.localStorage),
} = {}) {
  const blocked = new Set();
  function read(key) {
    if (blocked.has(key)) return false;
    try {
      const choice = storage().getItem(`atlas.analytics.${key}`);
      return choice === null ? defaultShare === true : choice === 'yes';
    } catch {
      return false;
    }
  }
  function write(key, value) {
    // A failed write must not restore default sharing after an opt-out in this page.
    blocked.add(key);
    try {
      storage().setItem(`atlas.analytics.${key}`, value === true ? 'yes' : 'no');
      blocked.delete(key);
    } catch {}
  }
  return {
    usage: () => read('consent'),
    repositories: () => read('repositories'),
    setUsage(value) {
      write('consent', value);
      if (value !== true) write('repositories', false);
    },
    setRepositories(value) {
      write('repositories', value === true && read('consent'));
    },
  };
}
const preferences = createAnalyticsPreferences({ defaultShare: analytics.defaultShare });
export const savedConsent = preferences.usage;
export const savedRepositoryConsent = preferences.repositories;
const pathname = globalThis.location?.pathname || '';
export const telemetry = createTelemetry({
  consent: savedConsent(),
  getConsent: savedConsent,
  getRepositoryConsent: savedRepositoryConsent,
  page: pathname.endsWith('/viewer.html')
    ? 'viewer'
    : pathname.endsWith('/privacy.html')
      ? 'privacy'
      : 'library',
});
export function setAnalyticsConsent(value) {
  preferences.setUsage(value);
}
export function setRepositoryConsent(value) {
  preferences.setRepositories(value);
}
