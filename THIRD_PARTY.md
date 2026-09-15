# Third-party notices

Atlas bundles the following runtime dependencies. Their upstream code, authorship and licenses are preserved in `vendor/`; they are not covered solely by Atlas's license.

| Dependency        | Version | Notice                                        |
| ----------------- | ------- | --------------------------------------------- |
| web-tree-sitter   | 0.25.10 | [MIT](vendor/LICENSE.web-tree-sitter)         |
| tree-sitter-wasms | 0.1.13  | [Unlicense](vendor/LICENSE.tree-sitter-wasms) |
| zip.js            | 2.15.0  | [BSD-3-Clause](vendor/LICENSE.zip.js)         |

Grammar notices: [C](vendor/LICENSE.tree-sitter-c), [C++](vendor/LICENSE.tree-sitter-cpp), [Rust](vendor/LICENSE.tree-sitter-rust), [JavaScript](vendor/LICENSE.tree-sitter-javascript), [TypeScript / TSX](vendor/LICENSE.tree-sitter-typescript), [Python](vendor/LICENSE.tree-sitter-python).

The exact asset sizes and SHA-256 hashes are recorded in [vendor/manifest.json](vendor/manifest.json). Node-only development dependencies are pinned in `package-lock.json` and are not included in the deployed application.

The header GitHub mark comes from [Primer Octicons](https://github.com/primer/octicons/blob/main/icons/mark-github-16.svg), used under its [MIT License](vendor/LICENSE.octicons).
