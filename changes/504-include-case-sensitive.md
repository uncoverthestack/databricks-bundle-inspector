Fixed

- **On Linux, a resource file whose name differs only in letter case from an included one now gets its "not included" warning** ([#504](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/504)). With only `resources/JOB.yml` included, `resources/job.yml` was treated as loaded too, although Linux keeps them as two files and the CLI loads one.
