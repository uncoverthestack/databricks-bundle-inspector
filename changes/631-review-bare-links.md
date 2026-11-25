Fixed

- **Web addresses in bundle text are no longer links in pasted reviews** ([#631](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/631)). A name such as `ops https://example.com` became a link when a copied review or the command line's Markdown report was pasted into GitHub. `http://`, `https://` and `www.` addresses from the bundle now get a zero-width space where GitHub would start a link, as mentions already do. Links to the docs are unchanged.
