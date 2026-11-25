# All resources

One resource of every type that CLI v1.28.0 accepts (issue 567): 43 types, the `resources:` keys in
`bundle/config/resources.go` without internal ones. For the overview and for crash tests.
Each resource is written like the CLI's own acceptance test for that type, kept small.

Checked on 2026-11-25 with CLI v1.28.0:

- `bundle validate --target __bundle_inspector_probe__` (the structural preview, no sign-in) printed all 43 types, with every `${resources...}` reference unresolved, so the YAML stands in for the CLI output in the tests.
- `bundle validate -t dev` passed, with `BUNDLE_VAR_secret_value` set. The variable has no default because validate refuses a default for a variable used as a secret value.
- Nothing was deployed, so whether the workspace accepts each resource (for example the external location's made-up credential) is not tested here.

When a CLI release adds a resource type, add one here; the unit test
`src/test/unit/extension/allResources.test.ts` lists the expected types.

| File | Types |
|---|---|
| `resources/compute.yml` | jobs, job_runs, pipelines, clusters, cluster_policies, instance_pools |
| `resources/sql.yml` | sql_warehouses, dashboards, alerts, genie_spaces |
| `resources/catalog.yml` | catalogs, schemas, volumes, external_locations, registered_models, secrets, quality_monitors, data_quality_monitors |
| `resources/ml.yml` | experiments, models, model_serving_endpoints, model_services, mcp_services, model_provider_services, features, feature_specs, materialization_sets, vector_search_endpoints, vector_search_indexes |
| `resources/apps.yml` | apps, secret_scopes |
| `resources/lakebase.yml` | database_instances, database_catalogs, synced_database_tables, and the nine postgres_* types |
