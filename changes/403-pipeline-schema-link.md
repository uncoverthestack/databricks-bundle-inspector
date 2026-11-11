Fixed

- **The bundle overview links a pipeline to the schema or catalog it references** ([#403](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/403)). A pipeline whose `catalog` or `schema` is `${resources.schemas.<key>...}` showed no line to that schema, while a job task with the same reference did. Any `${resources.<group>.<key>...}` in a pipeline's settings now draws a line to that resource, or to a box marked "may not exist" when the bundle has no such resource. Plain names like `schema: sales` are not linked.
