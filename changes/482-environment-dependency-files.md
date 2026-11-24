Added

- **Local files in a job environment's `dependencies` are checked** ([#482](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/482)). `bundle validate` passes, and deploy fails with "file doesn't exist" or "no files match pattern". The usual mistake is a path written from the bundle root in `resources/job.yml`: `./dist/app.whl` is read as `resources/dist/app.whl`, and the finding says `Did you mean "../dist/app.whl"?`. Files deploy builds first, and pip flags such as `-r`, are left alone.
