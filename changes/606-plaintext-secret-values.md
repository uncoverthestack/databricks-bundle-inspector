Fixed

- **Plaintext secret checks include target-only secrets and full variable references** ([#606](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/606)). A secret written only under a target is checked at that target's line. `${variables.pw.default}` and `${variables.pw.value}` are also reported when `pw` has a value in the bundle's files, just as `${var.pw}` is. Values supplied outside the bundle are not treated as plaintext repository defaults, and findings never copy the secret's value.
