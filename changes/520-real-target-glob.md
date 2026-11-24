Fixed

- **With a real target, a pipeline glob whose folder doesn't exist now gets "Pipeline source folder has no files"** ([#520](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/520)). `bundle validate` and deploy pass such a glob, and the pipeline fails when it runs. The glob was left as a workspace path and not checked; the structural preview already caught it.
