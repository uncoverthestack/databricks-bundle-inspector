Fixed

- **Pipeline data flow names from dotted configuration keys no longer show backticks** ([#627](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/627)). A table named `${my.name}` with `my.name: gold` showed as `` `gold` ``, and `${my.catalog}.sales.orders` as `` `main`.sales.orders ``. They now show as `gold` and `main.sales.orders`, as Databricks reads them (checked with a pipeline update on Databricks CLI v1.28.0).
