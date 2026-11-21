Fixed

- **A wrong secret scope gets a warning on every line that uses it** ([#463](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/463)). Only the first line in a notebook was reported, so the next one only showed up after fixing it. The graph still shows the scope once.
