-- A long table name in a file named after it, as Databricks' lakeflow_pipelines_sql
-- example does: the box must keep its type visible and its file link inside it.
CREATE OR REFRESH MATERIALIZED VIEW orders_by_region_with_a_long_descriptive_name
AS SELECT * FROM orders_silver;
