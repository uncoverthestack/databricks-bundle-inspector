Fixed

- **Sign-in is offered again after `databricks auth logout`** ([#441](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/441)). When a sign-in file from an older CLI was still on disk, picking a real target said "your Databricks sign-in couldn't be used" with nothing to do next. It now says you're not signed in to this workspace and offers `databricks auth login`.
