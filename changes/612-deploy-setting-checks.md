Fixed

- **Catch three more settings that pass validation and fail deploy** ([#612](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/612)). Local wheel and JAR paths must match files, so a directory is reported even when a glob also matches a valid file. Project environments cannot be combined with inline versions, images or dependencies. For-each inputs now flag dynamic references embedded in a JSON list and explain how to use one reference as the whole value.
