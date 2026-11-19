Added

- **The bundle overview draws a dashed box for a warehouse or schema named by ID, name or variable** ([#444](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/444)). A dashboard, alert, Genie space or quality monitor with a plain `warehouse_id` links to the same dashed warehouse box a job gets, so you can see they share it. A volume, registered model or Unity Catalog secret links to a dashed `catalog.schema` box. Lines between boxes in the same column now bend further out the longer they are, so they no longer sit on top of each other.
