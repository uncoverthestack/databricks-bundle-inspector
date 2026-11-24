Fixed

- **A task with `source: WORKSPACE` and a relative path, in a job with `git_source`, is now an error** ([#524](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/524)). The CLI rewrites no task path in such a job, so the path reaches Databricks as written, and deploy refuses it ("Only absolute paths are currently supported"), even when the file is on disk. `bundle validate` passes. This applies to notebook, Python file and SQL file tasks. Use a path from `/Workspace`, or remove `source: WORKSPACE` to read the path from the job's Git repository.
