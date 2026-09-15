# Contributing

Atlas favors small, readable modules and direct browser APIs. Keep repository contents as data: never execute imported scripts, hooks or build commands.

## Development

```sh
npm ci --ignore-scripts
npm start
```

Make changes in the relevant `src/` directory. Run `npm start` again to rebuild the static files after edits. Tests run with Node's built-in test runner and use real WebAssembly grammars and worker integration where relevant.

Before submitting a change:

```sh
npm run format
npm test
npm run build
```

For rendering or navigation changes, also import a small repository in the browser and inspect both 2D and 3D. Node tests cannot validate GPU appearance or browser presentation timing.

## Dependencies

Runtime assets are checked into `vendor/` so the application does not fetch executable code from a CDN. Exact versions are recorded in `package-lock.json`, and asset hashes are recorded in `vendor/manifest.json`.

To refresh bundled assets after deliberately updating pinned versions:

```sh
npm ci --ignore-scripts
npm run vendor
npm test
npm run build
```

Update matching versions in `scripts/vendor-parsers.mjs`, preserve all upstream license notices, and review the resulting vendor diff. Do not format or hand-edit vendored code.

## Changes worth explaining

Describe the user-visible behavior, why it changes, and how it was checked. Keep import work bounded, preserve exact source locations through wrapping, and retain useful distant previews. Never include source archives, cached maps, credentials, local paths or machine-specific diagnostics in a contribution.
