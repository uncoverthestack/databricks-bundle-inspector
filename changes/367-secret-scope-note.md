Changed

- **A secret scope read by its resource key is a note, not a warning** ([#367](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/367)). `secret_scope_name_mismatch` ("Secret scope "app_scope" may not exist. Did you mean "app-secrets"?") now shows as a note, as a scope with that name may exist outside the bundle, which the inspector can't see.
