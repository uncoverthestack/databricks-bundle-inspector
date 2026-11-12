# Bundle review (#410)

A whole-bundle report fixture: two jobs, a pipeline, a schema, a volume, a warehouse and a secret scope, with included YAML files and three variables. Nothing in this fixture is deployed or run by its tests.

`bundleReviewReport.integration.test.ts` copies it to a unique temporary folder, validates the structural preview and the dev/prod targets with a real CLI, and builds the report from the CLI's output. By default a fake workspace on loopback answers authentication and workspace-directory calls; no login is needed. Set `INSPECTOR_TEST_PROFILE=DEFAULT` to use that profile's workspace instead. Set `INSPECTOR_TEST_WAREHOUSE` to an existing warehouse name to include its lookup; validation reads it without starting compute. The fake workspace always includes a lookup. Each real-workspace run uses a unique workspace root, deletes it in teardown, verifies that it is absent, and deletes both its fixture copy and the inspector's CLI temp folder. Environment overrides are restored.

Live results, 2026-11-12, Databricks CLI v1.26.0:

- The structural preview keeps `${var.label}-${var.outside}` as written and leaves variable defaults unexpanded.
- A development target resolves the target override and prefixes a job name with `[dev <short name>]`; it prefixes the schema with `dev_<short name>_`. Production has neither prefix. These are validation results; no deploy or job run was needed to read the CLI-resolved names the report consumes.
- `BUNDLE_VAR_outside` overrides the repository default. The resulting value appears both in `variables.outside.value` and in the job's name. The bundle report omits it in both places.
- The report retains target/default/lookup provenance, included-file locations, the pipeline's schema relationship, folded clean rows and its Mermaid diagram. It omits the workspace identity, including the development-mode schema prefix's user name.
- The unique workspace validation folder was deleted and its absence verified.

The output is checked by facts, not a snapshot of entire sentences. The test runs in `test:semantic:cli`, including the oldest supported CLI.
