Fixed

- **"Did you mean" no longer suggests a short name that is only part of the one written** ([#623](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/623)). A task value read from `load_orders_bronze` suggested the task `load`, and a widget `customer_id` suggested the parameter `id`. A name inside another now counts as close only when it is at least half of it, so `schema` still suggests `schema_name` and `laod` still suggests `load`. Applies to task keys, widgets, parameters, task values and folders.
