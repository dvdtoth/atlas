# Atlas

### A spatial code browsing experiment

Explore a repository as a continuous landscape: skim its shape in 2D, fly through its source in 3D, and follow a search result straight into the code.

**[Open Atlas](https://dvdtoth.github.io/atlas/)** · [How it works](docs/architecture.md) · [Contributing](CONTRIBUTING.md) · [Privacy](https://dvdtoth.github.io/atlas/privacy.html)

Atlas runs entirely in your browser. There is no source-processing server, account, or API key. Import a public GitHub repository, drop a ZIP, or choose a local folder. Indexing, layout, search and WebGPU rendering all happen on your device.

## Explore

1. Open Atlas in a desktop browser with WebGPU support.
2. Build the default map of **Atlas itself**, enter another public repository, or drop a repository ZIP.
3. Pan and zoom through folders and wrapped source columns. Switch to **3D Flight** to explore the same location in space.
4. Search filenames, symbols or text. Select a result to animate to it, with the source range highlighted in gold.

Distant code keeps its line-length silhouette; nearby code resolves into readable text. Colors group files by role—source, tests, build/config, documentation and data—with shades for file types. The source explorer provides selectable text. Right-click a file or source line to open its original GitHub location at the imported commit.

| View   | Controls                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------- |
| 2D     | Drag to pan; scroll to zoom; double-click to frame a file                                       |
| 3D     | Drag to look; WASD to fly; Space / C to move vertically; Shift to boost; scroll to adjust speed |
| Search | Command / Ctrl + K; select a result to travel to its source                                     |

Maps are cached in this browser's local library. Remove an entry to delete its saved source and map. A viewer URL identifies a local snapshot; sharing that URL does not share the source.

## Run locally

Use Node.js 22 or later:

```sh
npm ci --ignore-scripts
npm start
```

Open **http://127.0.0.1:8766**. Node serves static development files only; visitors to the deployed site do not need it.

```sh
npm test                # indexing, imports, search, geometry and UI lifecycle
npm run format:check    # consistent source formatting
npm run build           # static website in dist/
```

Deploy the contents of `dist/` to an HTTPS static host. Relative module, worker and asset URLs support subdirectory hosting. The included workflow tests, builds and deploys `main` to GitHub Pages. No repository build scripts or hooks are ever executed.

## What to expect

- **Imports are snapshots.** GitHub imports pin an immutable commit. ZIP and folder imports remain local and have no verified remote link. Git history, submodules and Git LFS objects are not imported.
- **Search is syntax-aware.** Tree-sitter indexes C, C++, Rust, JavaScript, TypeScript/TSX and Python. Other text files remain searchable by filename and literal text. This is not compiler-resolved references, refactoring or live editing.
- **Large imports need resources.** Defaults allow a 2 GiB compressed ZIP, 5 GiB of source and 16 MiB per file. Browser storage, memory and GPU limits may be reached earlier. Parsing and text-search budgets report partial coverage when reached.
- **GitHub has anonymous request limits.** If an import hits them, use the download link and drop the ZIP into Atlas. This avoids the REST API without a token or proxy.
- **WebGPU is required.** Use a compatible desktop browser over HTTPS or localhost. Hardware and browser capabilities determine rendering detail; Atlas adapts its text cache to available resources.

See [architecture and resource budgets](docs/architecture.md) for details.

## Privacy

Source, file paths and search queries stay on your device. Public imports contact GitHub directly; the static host serves application assets. Local files are never uploaded. Optional Umami analytics require configuration and visitor consent. A separate opt-in can share the names of repositories imported from public GitHub. ZIP and folder names are always excluded. No external analytics script, session replay or page-content capture is loaded. See the [telemetry setup and event reference](docs/telemetry.md).

See the [privacy page](https://dvdtoth.github.io/atlas/privacy.html) and [telemetry configuration](docs/telemetry.md).

## Inspiration

The idea for Atlas was inspired by **[Rik Arends' code visualization work](https://x.com/rikarends/status/2098710248164868534?s=20)**. His demonstration of code as a spatial, navigable structure sparked this experiment.

## License

Atlas is available under the [MIT License](LICENSE). Bundled parsers and ZIP support retain their upstream licenses; see [third-party notices](THIRD_PARTY.md).
