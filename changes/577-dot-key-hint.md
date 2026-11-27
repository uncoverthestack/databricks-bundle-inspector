Fixed

- **The fix hint for a resource key with a dot now says what happens to a bundle deployed before** ([#577](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/577)). The Databricks CLI uploads the new files before it crashes, so existing jobs may run the new code with their old settings. The hint used to say deploy stops before it creates anything.
