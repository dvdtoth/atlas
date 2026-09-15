# Optional Umami analytics

Atlas sends nothing until a visitor opts in. Usage analytics and public repository names have separate controls in the library. Disabling usage analytics also clears the repository-sharing choice. Do Not Track and Global Privacy Control override both choices, including across tabs.

## Connect Umami Cloud

1. In Umami, open **Websites → Add website**.
2. Use **Atlas** for the name and **dvdtoth.github.io** for the domain of the GitHub Pages deployment. For another deployment, use its hostname without a scheme or path.
3. Save, then open the website's **Edit → Tracking code** section. Copy the UUID in `data-website-id`.
4. Configure `src/shared/config.mjs`:

   ```js
   export const analytics = Object.freeze({
     endpoint: 'https://cloud.umami.is/api/send',
     website: 'your-public-website-id',
   });
   ```

5. Run `npm test`, `npm run format:check` and `npm run build`, then deploy `dist/`. The included GitHub Pages workflow does this on a push to `main`.
6. Open the hosted library and enable usage counters. This immediately sends a pageview. Enable repository-name sharing separately if desired, import a small public GitHub repository, then open its map.
7. In Umami, inspect **Pages** for app visits and **Events** for actions. Select `repository_viewed`, then its **Properties** view to break down `repo` values.

The website ID is public routing information, not an account API key. Atlas calls Umami's collection API directly; do not also paste the standard tracker script, which would duplicate collection and capture more URL information. No backend is needed.

For a self-hosted endpoint, add its origin to `connect-src` in all three HTML documents and `_headers`. GitHub Pages uses the HTML policies. Never put account credentials in the browser bundle.

## Events

| Event               | Properties                                     | What it measures                                               |
| ------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| Pageview (unnamed)  | Fixed URL and title                            | Visits to the library, viewer and privacy page                 |
| `import_started`    | `source`                                       | GitHub, ZIP or folder import attempts                          |
| `import_ready`      | `source`, `cache`, `files`, `bytes`, `seconds` | Completed imports, cache reuse, size and end-to-end time       |
| `import_failed`     | `source`, `reason`, `seconds`                  | Failure categories, without error messages                     |
| `import_cancelled`  | `source`, `seconds`                            | Abandoned imports                                              |
| `cache_opened`      | —                                              | Opens from the saved library                                   |
| `viewer_ready`      | `source`, `files`, `seconds`                   | Maps that successfully initialize the GPU viewer               |
| `repository_viewed` | `source: github`, `repo`                       | Public repositories reaching the viewer, with separate consent |
| `view_changed`      | `mode`                                         | 2D/3D switches                                                 |
| `search_used`       | `mode`, `results`                              | Search engagement, at most once per mode per minute            |
| `result_selected`   | `mode`                                         | Search results followed on the map                             |
| `github_clicked`    | —                                              | Clicks on Atlas's header GitHub link                           |

Start with import success versus failures, import times by source, use of saved maps, public repo popularity, and 3D/search engagement. These are aggregate indicators, not exact funnels: consent, blockers, network loss and collection limits can omit events. Search counts measure sampled engagement rather than every query.

Keep costs low by recording deliberate actions rather than mouse movement, frames, flight position, keystrokes or source reads. The client caps collection at 30 events per minute per document, with no retry queue. Counts are coarsened and timings rounded to whole seconds. Pageviews are emitted at most once per document after consent.

## Data boundaries

Page paths are fixed logical app paths (`/`, `/viewer.html`, `/privacy.html`), even on subdirectory hosts. Query strings, hashes, dynamic page titles, referrers and local snapshot IDs are excluded. Atlas never sends code, file paths, symbols, search text, ZIP/folder names or raw errors. It loads no external tracker, uses no session replay and persists no analytics visitor ID.

Only canonical names returned by GitHub's public-repository check can reach `repository_viewed`. The name is normalized to `owner/repo` and is sent only after the map loads and the visitor enables both consent controls. There is no inferred identity for ZIP/folder imports. Older saved maps without public-origin metadata remain usable but do not report repository names; removing that saved map and importing again creates the metadata.

The collection endpoint receives normal HTTP metadata, including IP address and browser User-Agent. Umami can derive aggregate visitor, browser, operating-system and location statistics from requests. Atlas does not send custom user identifiers or raw GPU details. Configure retention in Umami and keep the privacy page accurate for your deployment.

If nothing appears, check that the deployed configuration contains the correct ID and that the visitor enabled counters. Inspect the browser Network panel for a POST to `/api/send`. Browser privacy signals, content blockers, CSP or a network failure can prevent collection; Atlas continues to work without analytics.

See Umami's official [website setup](https://docs.umami.is/docs/add-a-website), [collection API](https://docs.umami.is/docs/api/sending-stats) and [custom events](https://docs.umami.is/docs/track-events) documentation.
