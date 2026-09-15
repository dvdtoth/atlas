# Bundled parser assets

The static app serves these files from its own origin. It does not load code from
CDNs or from imported repositories. `src/index/client-search.mjs` imports the ES module
runtime; languages are loaded lazily inside the project worker.

Run `npm ci --ignore-scripts` and `npm run vendor` from the repository root to reproduce the
runtime and grammar binaries. The lockfile pins the npm tarball integrities;
`manifest.json` records the SHA-256 and size of every shipped parser asset.

- [web-tree-sitter 0.25.10](https://github.com/tree-sitter/tree-sitter/tree/v0.25.10/lib/binding_web), MIT.
- [tree-sitter-wasms 0.1.13](https://github.com/Gregoor/tree-sitter-wasms), Unlicense packaging, with the grammar copyrights retained in the adjacent LICENSE files.

The grammar bundle pins the distributed binaries, but its package metadata gives
ranges for the source grammar versions. Parser provenance therefore identifies
the grammar name and the exact WASM bundle version rather than claiming a source
grammar patch version. C, C++, Rust, JavaScript, TypeScript, TSX and Python are
covered. Newer language syntax can produce partial coverage. The extractor also
reports unsupported languages and resource limits explicitly.

Upstream grammar copyright notices are retained from the versions at the lower
end of the bundle's declared source ranges:

| Grammar | Source / licence notice |
| --- | --- |
| C | [tree-sitter-c v0.20.7](https://github.com/tree-sitter/tree-sitter-c/blob/v0.20.7/LICENSE) |
| C++ | [tree-sitter-cpp v0.20.4](https://github.com/tree-sitter/tree-sitter-cpp/blob/v0.20.4/LICENSE) |
| Rust | [tree-sitter-rust v0.20.4](https://github.com/tree-sitter/tree-sitter-rust/blob/v0.20.4/LICENSE) |
| JavaScript | [tree-sitter-javascript v0.20.3](https://github.com/tree-sitter/tree-sitter-javascript/blob/v0.20.3/LICENSE) |
| TypeScript / TSX | [tree-sitter-typescript v0.20.5](https://github.com/tree-sitter/tree-sitter-typescript/blob/v0.20.5/LICENSE) |
| Python | [tree-sitter-python v0.21.0](https://github.com/tree-sitter/tree-sitter-python/blob/v0.21.0/LICENSE) |

Compatibility follows the [0.25.10 runtime API](https://github.com/tree-sitter/tree-sitter/blob/v0.25.10/lib/binding_web/README.md).
The deprecated timeout setter is not used: extraction uses the supported parser
progress callback to enforce its 100 ms deadline. All seven grammars are exercised
with real WASM in `tests/test_client_search.mjs`.
