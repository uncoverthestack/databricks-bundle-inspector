Fixed

- **A resource with the key `__proto__` is shown, no longer dropped without a word** ([#510](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/510)). The Databricks CLI accepts the key and prints the resource, and the inspector lost it while reading the CLI's output, so the graph and the overview had nothing for it. Variables and targets with that name are kept too.
