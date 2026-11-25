Fixed

- **Pipeline checks follow the sources deploy uploads** ([#600](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/600), [#607](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/607)). Read dot-prefixed SQL sources, including a folder containing only hidden SQL. Leave excluded files out of lineage, secret reads and refresh-selection checks, while respecting `sync.include`. An unreadable source folder gets an error and an incomplete-data-flow notice, instead of advice to remove a table the inspector could not check.
