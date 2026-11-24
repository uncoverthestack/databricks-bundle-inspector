Fixed

- **A task left with `source: GIT` after `git_source` is removed from its job is now an error, and its path is checked** ([#521](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/521)). `bundle validate` passes, but deploy refuses the setting, for notebook, Python file and SQL file tasks. It was a warning, and only for notebooks. The path is now checked as a local file, as the CLI reads it, so a missing extension gets its "Did you mean".
- **A task in a job with `git_source` no longer gets "File not found"** ([#521](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/521)). Its path is in the Git repo, which the CLI doesn't check, also when the task leaves `source` out.
