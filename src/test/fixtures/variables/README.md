# variables

Fixture for bundle variables: one valid bundle with every way the docs and the Databricks CLI's own tests define, set and use a variable. Each value below is what CLI 1.21.0 deploys for that target; the same results hold on 0.299.0, 0.299.2 and 1.17.0.

`validated-bundle.json` is the CLI's structural preview output (`npm run fixtures:update:validated-bundle -- --fixture src/test/fixtures/variables`).

## Cases

| Task setting | Case | Preview shows | Click opens |
|---|---|---|---|
| `whole_values.catalog` | plain default | `main`, DEFAULT | `default: main` |
| `whole_values.retries` | number | `3` | `default: 3` |
| `whole_values.owner_email` | no default, every target sets it | NO DEFAULT, no problem | its definition |
| `whole_values.table_prefix` | default built from another variable | `${var.catalog}_tbl` (shown as written) | its default |
| `whole_values.duplicated` | set in `databricks.yml` and `resources/zz_later.yml` | `from_the_last_included_file`: the CLI loads includes after `databricks.yml`, in order, and the last wins | `resources/zz_later.yml` |
| `whole_values.from_include` | defined in an included file | `defined_in_an_include` | `resources/shared_vars.yml` |
| `inside_strings.*` | references inside a string, two in one string | each variable's value | each default |
| `complex_fields.node_type` | field of a complex map | `i3.xlarge` | the map's first line |
| `complex_fields.tag_owner` | nested field | `data-platform` | the map |
| `complex_fields.init_script` | list item, then fields | `/Shared/init.sh` | the map |
| `complex_fields.second_region` | item of a complex list | `us-west-2` | the list |
| `lookup_value.warehouse_id` | lookup | LOOKUP | the lookup |

With a target picked:

| Target | Case | Deploys |
|---|---|---|
| `dev` | no override | defaults; `owner_email` = `dev-team@example.com` |
| `staging` | full form `catalog: {default: ...}` | `staging_catalog` |
| `staging` | shorthand complex value `cluster: {node_type_id: ...}` | `i3.2xlarge`, `/Shared/staging-init.sh` |
| `staging` | override in an included file | `schema` = `staging_schema_from_include` |
| `qa` | `<<: [*qa_catalog, *qa_catalog_later]` | `catalog_from_later_anchor`: the later anchor wins (unlike the YAML spec) |
| `prod` | `labels: {default: ..., team: prod-team}` | `team` = `prod-team`: a key that is not a variable setting makes the whole map the value |
| `prod` | `retries` written twice | `5`: the last one |

Job-level references (the job's `tags`) are resolved by the CLI but are not listed in a task's panel: the inspector tracks task settings only.

## Tests

- `src/test/unit/extension/variableFixtures.test.ts`: the panel's value, badge, problem and click line for each case, from `validated-bundle.json`. No CLI needed.
- `npm run test:variables:cli`: every target through a real CLI, comparing what the panel shows with what the CLI deploys, plus a `BUNDLE_VAR_catalog` environment variable and a `variable-overrides.json`, which both beat a target's override.
  - Without `INSPECTOR_TEST_PROFILE` (CI): against a fake workspace on 127.0.0.1. Nothing real is contacted.
  - With `INSPECTOR_TEST_PROFILE=<profile>`: against that profile's workspace, one target at a time. Set `INSPECTOR_TEST_WAREHOUSE` to the name or ID of a SQL warehouse to include the lookup; given an ID, the test asks the workspace for its name once and checks the lookup resolves to that ID. Each target's validate creates an empty `.bundle/dbi-variables-it/<target>/files` folder there.

A list item a target's value does not have (for example `${var.cluster.init_scripts[0]}` with `init_scripts: []`) makes `bundle validate` very slow ("Variables references are too deep"), so no target here does that.
