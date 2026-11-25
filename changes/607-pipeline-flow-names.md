Fixed

- **Pipeline flow selections use full names** ([#607](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/607)). `refresh_flow_selection` needs `catalog.schema.flow`, including for a table's own flow. A short name now gets a warning and, when its namespace is known, a full-name suggestion. Flows whose query reads no table are retained, so a working full name no longer gets a suggestion for a different flow. The SQL data flow also keeps self-reads, reads relations after `LATERAL`, and treats recursive CTE references as local.
