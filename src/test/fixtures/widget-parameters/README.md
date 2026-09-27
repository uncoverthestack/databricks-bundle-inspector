# Widget parameters

Notebook tasks pass `base_parameters`, and the job's `parameters`, to the notebook as widgets. Job parameters are pushed down to every notebook task and win over a task parameter with the same key. A notebook that reads a widget nobody passes fails when it runs, unless the notebook gives the widget a default ([docs](https://docs.databricks.com/aws/en/jobs/parameter-use)). `databricks bundle validate` reports "Validation OK!" for this bundle (CLI v1.17.0).

| Task | Notebook reads | Passed | Inspector |
|---|---|---|---|
| `python_notebook` | `catalog` | job parameter | No issue |
| `python_notebook` | `schema` | only `schema_name` | Warning: may not pass `schema`. Did you mean `schema_name`? |
| `python_notebook` | `env` | nothing, but `dbutils.widgets.text("env", "dev")` | No issue |
| `python_notebook` | `run_date` | nothing | Warning: may not pass `run_date` |
| `python_notebook` | (never reads `unused_flag`) | `unused_flag` | Info: may not be used |
| `sql_notebook` | `:catalog`, `:schema` in `IDENTIFIER()` | job parameter, `schema` | No issue |
| `sql_notebook` | `:limit_rows` | nothing, but `CREATE WIDGET TEXT limit_rows DEFAULT '10'` | No issue |
| `sql_notebook` | legacy `'${region}'` | nothing | Warning: may not pass `region` |
| `sql_notebook` | `ts::string`, `raw:owner`, `'12:30'` | | Not widgets: a cast, a JSON path, a string |
| `runs_shared` | `from_shared_notebook` | nothing | No issue: `%run` may define it |
| `dynamic_reads` | a name held in a variable | `a`, `c` | Info: not checked whether the notebook uses `a`, `c`, because the names are only known at runtime |
| `widgets_object` | `dashboard_id` via `dbutils.widgets.text`, the rest through `load_config(widgets=dbutils.widgets)` | `dashboard_id`, `warehouse_id` | Info: not checked whether the notebook uses `warehouse_id` (`dashboard_id` is defined), because the widgets object is passed to other code, as in Databricks' own bundle-examples |
| `for_each_item` inner task | `missing_inner` | only `item` | Warning: may not pass `missing_inner` |
| `git_sourced` job | | | No issue: the notebook comes from Git |
