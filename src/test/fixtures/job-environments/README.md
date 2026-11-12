# job-environments

Fixture for the job environment checks from #418. `bundle validate` accepts every case. The deploy and run results are from Databricks CLI v1.26.0 against a serverless workspace (2026-11-12), one bundle per case, each with a Python script task.

| Environment or task | Case | Deploy and run | Inspector |
|---|---|---|---|
| `deps_only` | `spec` with only `dependencies` | deploy fails: `Either base environment, version, or project_environment must be provided` | `environment_version_missing` |
| `empty` | `spec: {}` | deploy fails, as above | `environment_version_missing` |
| `no_spec` | no `spec` | deploy fails, as above | `environment_version_missing` |
| `version` | `environment_version: "5"` | deploys, runs on `client.5.12` | nothing |
| `from_variable` | `environment_version` from a variable | (a variable is resolved before deploy) | nothing |
| `old_client` | `client: "2"`, the older field | deploys, runs on `client.2.5` | nothing |
| `base` | `base_environment: .../databricks_ml_v5` | deploys, runs on `client.5.12` | nothing |
| `project` | `project_environment` whose `pyproject.toml` has no version | deploys; the run fails: `pyproject.toml must specify environment_version or base_environment under [tool.databricks.environment]` | `project_environment_version_missing` |
| `pinned_project` | the same, with `[tool.databricks.environment]` `environment_version = "5"` | deploys, runs on `client.5.12` | nothing |
| task `typo` | `environment_key: versoin` | deploy fails: `Job environment 'versoin' used by task typo is not defined in field 'environments'` | `unknown_environment_key`, suggests `version` |
| task `fine` | `environment_key: version` | deploys | nothing |
| task `loop`'s inner task | `environment_key: bse` | deploy fails, as `typo` | `unknown_environment_key`, suggests `base` |

`validated-bundle.json` is the CLI's structural preview output, captured with no credentials (`DATABRICKS_CONFIG_FILE=/dev/null`): the findings need no login. A CLI older than v1.20.0 doesn't know `project_environment` and drops it with an "unknown field" warning (seen on v0.299.2, the oldest supported), so its baseline would differ. That is why `semantic-cli-matrix.config.json` gives this fixture `"minCliVersion": "1.20.0"` (JSON has no comments, so the reason lives here). How the version was found: `project_environment` is not in the CLI's `bundle/schema/jsonschema.json` at tag v1.19.0 and is from v1.20.0 (databricks/cli source). `src/test/integration/jobEnvironments.integration.test.ts` checks the older behaviour.
