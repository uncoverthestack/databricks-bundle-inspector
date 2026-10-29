Fixed

- **A file opened from the graph must really be in the workspace** ([#326](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/326)). The graph opens a file only when it is inside the bundle or an open workspace folder; that check now also follows symlinks, so a link inside the workspace that leads outside it no longer opens. Links that lead to another file in the workspace still open.
