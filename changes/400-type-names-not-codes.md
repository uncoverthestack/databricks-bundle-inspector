Changed

- **Types are named in Databricks' words, not short codes** ([#400](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/400)). Task boxes, the Uses row, the bundle overview and the pipeline view showed codes the inspector made up (NB, PY, J, WH, C, S…), and If/else and For each tasks showed the same J as Run Job. Each item now has a small dot in its type's colour and its type in words: "Notebook · notebooks/ingest", "If/else", "SQL warehouse · 3 tasks". Serverless or inherited compute is called compute, not a cluster.
