# Schema renamed in a target

The CLI adds a target's name prefix to every schema the bundle defines (`apply_presets.go`, v0.299.2 to v1.25.0): `mode: development` makes `dbi_sales` into `dev_<user>_dbi_sales`. Only `${resources.schemas.sales.name}` follows the rename; a name written in code or task parameters does not, and the run fails with `SCHEMA_NOT_FOUND` (tested by running a job on a serverless workspace, CLI v1.24.0, issue 235). `databricks bundle validate` reports "Validation OK!" for `dev` and `staging` (CLI v1.25.0).

| Task | Writes | Inspector |
|---|---|---|
| `python_code` | `spark.table("workspace.dbi_sales.orders")`; also reads `${resources.schemas.sales.name}` from a widget | Warning once for the file, at the first written name. The reference is fine |
| `sql_code` | `` `workspace`.`dbi_sales`.orders ``, `dbi_sales.orders`, and the name in a comment | Warning once for the file. The comment doesn't count |
| `comments_only` | the name in a comment, a docstring with no dot, a plain string with no dot | No issue: a name on its own is not read as a schema |
| `literal_parameter` | `schema: dbi_sales`, `table: workspace.dbi_sales.orders` | Warning for each parameter |
| job `uses_schema` | job parameter `target_schema` defaults to `dbi_sales` | Warning once for the job |
| `other_schema` | `dbi_sales_archive`, `dbi_sales_orders` | No issue: other names |
| `from_git` job | | No issue: the notebook comes from Git |

The `staging` target renames nothing. Without a development or prefixed target, nothing is reported.
