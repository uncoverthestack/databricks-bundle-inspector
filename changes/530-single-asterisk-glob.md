Fixed

- **A pipeline glob Databricks refuses, such as `../src/dlt/*` or `../src/dlt/*.sql`, is now an error** ([#530](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/530)). `bundle validate` passes it, and deploy fails with "Single asterisk glob pattern is not supported": the only wildcard Databricks takes is a trailing `/**`. The finding says `Did you mean "../src/dlt/**"?`, with a quick fix. A `folder/*` glob was treated as valid before.
