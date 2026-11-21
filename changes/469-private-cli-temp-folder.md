Security

- **On a shared Linux machine, the CLI's temp folder can't be taken over by another user** ([#469](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/469)). The folder the CLI keeps its working files in is now created for your user only. If it or its parent was made by someone else, can be written by others, or is a link, a new private folder is used instead.
