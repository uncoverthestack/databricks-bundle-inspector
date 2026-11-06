# Secret scopes

How the inspector links secret use to scopes (issue #86). `app_scope` is a bundle scope whose real name is `app-secrets`.

| File or config | Expected |
|---|---|
| `src/defined_name.py` uses `app-secrets` | Linked to the bundle scope |
| `src/by_key.py` uses `app_scope` (the resource key) | Warning: that scope doesn't exist, use `app-secrets` |
| `src/list_by_key.py` and `src/list_by_key_positional.py` call `dbutils.secrets.list` with `app_scope`, by keyword and by position | Same warning as `by_key.py` (#236) |
| `src/external.py` uses `shared-team-scope` | External scope, no warning |
| `src/dynamic.py` takes the scope from a variable | Not linked (only known at runtime) |
| `src/commented.py` has the call in a comment | Ignored |
| `src/query.sql` uses `secret('sql-scope', ...)` | Linked |
| `src/nested_item.py`, run by a `for_each` task | Linked |
| `src/dlt/bronze.py`, a pipeline source | Linked to the pipeline |
| `{{secrets/env-scope/...}}` and `{{secrets/conf-scope/...}}` in the job cluster | Linked to every task on that cluster |
