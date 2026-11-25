Fixed

- **A task value read written in YAML is reported where it is written** ([#637](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/637)). A `{{tasks.<task>.values.<key>}}` in a task's settings got its finding at the task's first line. It now points at the line and column of the reference, inside a list or a for-each loop's inner task too.
