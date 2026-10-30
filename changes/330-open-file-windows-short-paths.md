Fixed

- **On Windows, a file opens from the graph whichever form its folder's path takes** ([#330](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/330)). A file that exists is now checked by where it really is, so a workspace folder written in Windows' short 8.3 form (`C:\Users\RUNNER~1\...`) no longer stops a file under it, written in full, from opening.
