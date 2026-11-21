Fixed

- **Names in Python strings are read as Python reads them** ([#453](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/453)). `dbutils.widgets.get("region")` reads the widget `region`, so it no longer gives a missing widget warning and an unused parameter warning for a task that passes `region`. The same applies to secret scopes and keys, task values and run paths. A `\` line continuation inside a string, in a file with Windows line ends, no longer cuts the string short.
