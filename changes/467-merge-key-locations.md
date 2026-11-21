Fixed

- **Findings on a setting that comes from a YAML merge key (`<<: *anchor`) point at its line** ([#467](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/467)). They had no line and showed at the top of the file. The line is where the anchor writes the value, and a key written in the task itself still wins.
