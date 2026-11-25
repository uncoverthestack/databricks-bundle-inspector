Fixed

- **A short value set outside the repository no longer scrambles the copied review** ([#635](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/635)). The review leaves such values out, and a value like `1` or `r` was replaced inside every word and number: `daily.yml:12` became `daily.yml:[omitted]2`. A value of three characters or fewer is now left out only where it stands on its own, longer values wherever they appear as before, and line numbers are never changed.
