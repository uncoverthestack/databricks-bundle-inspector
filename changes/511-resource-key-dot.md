Fixed

- **A resource key with a dot is an error, as deploy stops on it** ([#511](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/511)). `bundle validate` accepts a key such as `nightly.load`, and `bundle deploy` then fails before it creates anything, with "Invalid resource name" or a Databricks CLI crash, on every CLI from v0.299.2 to v1.28.0. The finding, `resource_key_has_dot`, is on the key's line and names a key with `_` instead. Before, a job such as `a.tasks.b` could also hide behind task `b` of job `a` in the graph.
