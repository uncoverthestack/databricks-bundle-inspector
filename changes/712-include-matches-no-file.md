Fixed

- **A resource file in a sub-folder is flagged when no file matches `include`** ([#712](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/712)). With `include: ["resources/*.yml"]` and the only job file in `resources/jobs/`, the Databricks CLI loads nothing, so the job is never deployed. `resource_not_included` said nothing in that case, only when another file sat directly in `resources/`. It now warns. A misspelled pattern that gets "Did you mean" stays one finding.
