# Architecture

Atlas is a static application built from native JavaScript modules, Web Workers, WebAssembly and WebGPU. There is no framework, runtime server or repository execution environment.

## Source layout

| Directory     | Responsibility                                                                        |
| ------------- | ------------------------------------------------------------------------------------- |
| `src/import/` | GitHub, ZIP and folder adapters; bounded parallel indexing; progress and cancellation |
| `src/index/`  | Source profiles, folder packing, syntax symbols, local search and IndexedDB snapshots |
| `src/render/` | Source geometry, visibility, cameras, text tiles and WebGPU pipelines                 |
| `src/ui/`     | Library, viewer, source explorer and repository links                                 |
| `src/shared/` | Worker messaging and optional telemetry                                               |
| `styles/`     | Library and viewer presentation                                                       |
| `vendor/`     | Pinned parser runtimes, grammars, ZIP reader and upstream licenses                    |
| `tests/`      | Node tests, including real parser and worker integration                              |
| `scripts/`    | Static build, development server and vendor refresh                                   |

## Import → snapshot → map

1. An adapter enumerates supported source files. GitHub metadata resolves to one immutable commit; ZIP and folder adapters validate local paths and file limits.
2. Read-ahead overlaps IO, decompression and hashing. A bounded pool of indexing workers measures source and extracts syntax symbols.
3. Results are consumed in source order so worker completion order cannot change document IDs or retained symbol selection. IndexedDB writes are batched. Source and temporary line-length profiles are stored separately in the same transaction.
4. The layout pass packs the folder hierarchy into a rectangular map and builds small source previews by reading profiles only, without rereading source text or syntax records. A ready snapshot is published only after its source, map and index are complete; publishing also removes the temporary profiles. Existing saved maps remain compatible.
5. A geometry worker prepares resident GPU buffers. The viewer receives geometry and previews; source pages are requested from local storage as needed.

Cancellation terminates the active workers and removes partial source. An interrupted tab can leave an unfinished library entry, which can be removed. Storage is a rebuildable cache, subject to browser quota and eviction.

## Shape and navigation

Source is retained as original UTF-8. Display wrapping is separate: a bounded line-width histogram estimates a typical width, unusually long lines wrap, and long files flow through ordered columns. Source-to-display mapping preserves search locations and original line numbers.

Folders use deterministic, weighted binary partitioning. Children fill their parent rectangle while remaining together; files retain their internal source order. File color is derived from role and type, independently of position.

The 3D view folds source sheets into space. The same source addresses connect 2D, 3D and the source explorer. Search travel interpolates camera position and zoom; selected ranges are split across columns or folds and rendered as depth-tested gold overlays.

## Rendering

Compact resident geometry and hierarchical visibility keep frame work proportional to visible detail. The GPU draws source-length previews at distance. A worker rasterizes readable text near the camera; bounded caches retain multiple resolutions, with mipmaps and anisotropic filtering for flight views. Cached lower-resolution text remains available while a sharper tile is prepared.

Text detail adapts between three budgets using browser capability hints and measured foreground CPU/GPU queue pressure. Those measurements guide resource use; they are not a guaranteed refresh rate. Camera-relative coordinates limit floating-point jitter across large maps.

## Search

Filename suggestions use a dedicated worker. Syntax search uses retained Tree-sitter symbol records; the parser and syntax tree are discarded after extraction. Literal text search scans cached source within explicit work limits. Unsupported languages and partial syntax coverage remain visible to users.

## Resource budgets

| Resource                         | Default limit                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------- |
| Source import                    | 5 GiB total; 16 MiB per file; 600,000 files                                      |
| Compressed ZIP                   | 2 GiB; 600,000 entries                                                           |
| ZIP compressed-page cache        | 8 MiB                                                                            |
| Local source read-ahead          | 1–4 files; 32 MiB admission budget                                               |
| Indexing workers                 | 1–4 workers; at most 4 queued results per worker; 32 MiB source admission budget |
| Storage batch                    | 32 documents or approximately 8 MiB                                              |
| Snapshot buffer                  | 128 MiB per buffer                                                               |
| Geometry and visibility estimate | 256 MiB                                                                          |
| GPU text cache                   | 160 / 384 / 640 MiB, depending on detail tier                                    |
| Retained symbols                 | 500,000 records or approximately 96 MiB                                          |
| Syntax parsing                   | 2 MiB and approximately 100 ms per file; 8,192 records per file                  |
| Literal text query               | 128 MiB, 25,000 documents or 3 seconds                                           |

These are individual component guards, not a bound on total RAM. Source profiles, structured clones, browser overhead and GPU uploads consume additional memory. Import and allocation limits stop with an explanation; search limits report partial coverage.

## Static deployment

`npm run build` copies an explicit allowlist into `dist/`; it excludes tests, development dependencies and local files. URLs remain relative, including worker entry points and WebAssembly assets.

GitHub Pages deploys through Actions. Other hosts can serve the same output with JavaScript and WebAssembly MIME types. The HTML includes a content security policy; `_headers` additionally supplies response policies for hosts that support it and the local server. GitHub Pages does not apply custom `_headers` response headers.

The application shell is fetched on each visit. Atlas is not an offline service-worker application. Browser storage is isolated by origin, so changing a hostname or port creates a separate library.
