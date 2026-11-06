Fixed

- **`dbutils.secrets.list` is checked for the wrong secret scope name, like `get`** ([#236](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/236)). Code that lists a bundle secret scope by its resource key instead of its `name`, such as `dbutils.secrets.list(scope="app_secrets")` for a scope named `prod-app-secrets`, deploys and then fails when the job runs with "Scope does not exist". The `secret_scope_name_mismatch` warning now covers `list` as well as `get` and `getBytes`.
