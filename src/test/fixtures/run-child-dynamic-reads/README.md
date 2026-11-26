# run-child-dynamic-reads

Fixture for a notebook run with `%run` that reads a widget by a name known only at runtime next to one read by name (#602). One job per case; each task's notebook runs `./child` with `%run`, and nothing passes `needed`.

| Job | `child` | Inspector |
|---|---|---|
| `variable_and_named` | `get(name)` and `get("needed")` | `widget_not_set` for `needed` |
| `get_all_and_named` | `getAll()` and `get("needed")` | `widget_not_set` for `needed` |
| `named_only` | `get("needed")` | `widget_not_set` for `needed` |
| `variable_only` | `get(name)` | nothing |
| `named_with_default` | `text("needed", "x")`, `get(name)`, `get("needed")` | nothing |

What Databricks does is in the live probe `widget_run_child_dynamic_read` (src/test/liveRules/probes).

`validated-bundle.json` is the CLI's structural preview output, captured with no credentials (`DATABRICKS_CONFIG_FILE=/dev/null`).
