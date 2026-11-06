Added

- **A "Uses" row above the job graph shows the SQL warehouses, clusters and secret scopes the job uses** ([#363](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/363)). Each chip says how many tasks use it, so tasks sharing a warehouse are visible without clicking a task. A solid chip is defined in the bundle; a dashed one is named by a variable or an ID, is a secret scope from outside the bundle, or is the serverless default. Pointing at a chip lights up its tasks; clicking keeps them lit. The graph itself is unchanged.
