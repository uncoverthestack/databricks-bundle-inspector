Fixed

- **Names in the review reports show as text: never a link, an image, HTML or an `@mention` that notifies someone** ([#473](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/473)). The job report pasted names and messages from the bundle into the pull request as they were. Both reports now escape them, and code such as file paths is unchanged.
