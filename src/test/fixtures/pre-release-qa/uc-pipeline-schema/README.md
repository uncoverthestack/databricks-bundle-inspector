# Unity Catalog Pipeline And Schema

This fixture covers current resource-style configuration with a schema resource, a pipeline that references it, and a job that runs the pipeline.

Expected behavior:

- The schema, pipeline, and job resources are visible.
- The pipeline source file resolves locally.
- Cross-resource references are represented in the graph.
- Target switching changes the schema variable without stale graph data.
