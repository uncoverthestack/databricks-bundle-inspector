Fixed

- **The task graph no longer shows a stray arrowhead for a dependency loop** ([#338](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/338)). When tasks depend on each other in a loop, or a task depends on itself, the arrow that closes the loop ran under the task boxes and only its arrowhead showed. The graph now leaves that arrow out, so it always reads as a DAG. The loop error and the task's "Depends on" list still name every dependency.
