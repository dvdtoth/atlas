# Optional telemetry

Telemetry is disabled in the default build. Atlas uses no analytics script, session replay, automatic page capture or persistent client tracking ID.

To enable an existing Umami website, configure `src/shared/config.mjs` with its public website identifier and collection endpoint, then rebuild. No secret or API token belongs in this file.

```js
export const analytics = Object.freeze({
  endpoint: 'https://cloud.umami.is/api/send',
  website: 'your-public-website-id',
});
```

For a self-hosted endpoint, add its origin to `connect-src` in all three HTML documents and `_headers`. Visitors must opt in through the library checkbox. Do Not Track and Global Privacy Control override consent; visitors can withdraw consent at any time.

Only allowlisted event names, coarse counts, rounded timings and fixed modes are sent. Repository names, source, paths, symbol names, search text, error messages and page query strings are excluded. The endpoint still receives normal HTTP metadata, including an IP address. Configure its retention and processing appropriately, and keep the privacy page accurate for your deployment.
