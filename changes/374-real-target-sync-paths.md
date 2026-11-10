Fixed

- **Files `bundle deploy` skips are reported with a real target picked, not only in the preview** ([#374](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/374)). The Databricks CLI fills in `sync.paths: ["."]` when the bundle sets none, and the inspector read any `sync.paths` as a different sync root, so with a real target the `excluded_from_sync` warning never appeared. It now only stops checking when `sync.paths` reaches outside the bundle folder.
