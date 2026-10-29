Fixed

- **VS Code 1.99 and older no longer install a version that can't start** ([#307](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/307)). The extension needs VS Code 1.100 or newer, the first that can load an extension written as JavaScript modules, but said it supported 1.85. On 1.85 to 1.99, or an editor built on them, it installed and then failed to start. Those versions now say it needs a newer VS Code.
