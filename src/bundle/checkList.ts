/**
 * The list of checks (#648): for each finding code, its family (its section in
 * docs/checks.md) and what it stops, taken from what that section says.
 *
 * `stops` is the first step that goes wrong when the mistake is left in, which is what the
 * inspector is for: a deploy or a job run that would fail or do the wrong thing.
 *
 * - `validate`: the Databricks CLI's own `bundle validate` stops, with a real target. The
 *   inspector says so in the structural preview, before one is picked.
 * - `deploy`: `bundle validate` passes and `bundle deploy` fails.
 * - `run`: deploy passes, and the job, task or pipeline update fails.
 * - `silent`: it deploys and runs, but does something other than what is written.
 * - `advice`: nothing fails; worth a look.
 * - `coverage`: not a mistake in the bundle, but something the inspector couldn't check.
 * - `cli`: passed through from the Databricks CLI as it reported it.
 *
 * Left out where docs/checks.md doesn't say which step fails: those are listed in the test,
 * which only lets the list shrink, as each is confirmed by deploying and running (#650).
 *
 * A code not shipped yet must meet the bar in docs/adding-a-check.md: a live probe, a near-miss
 * test and a step here (checked by checkList.test.ts), and the real-bundles pull request check.
 *
 * Every code that has shipped is in shippedCodes.json, with the release it first shipped in
 * since 0.4.0, when codes stopped changing. A shipped code is never renamed or removed.
 */

import type { InspectorIssueKind } from "./issues.js";

export type CheckFamily = "files" | "include" | "jobs" | "compute" | "code" | "configuration";

export type CheckStops = "validate" | "deploy" | "run" | "silent" | "advice" | "coverage" | "cli";

export interface CheckInfo {
  family: CheckFamily;
  stops?: CheckStops;
}

export const CHECKS = {
  // Files and paths
  missing_file: { family: "files", stops: "validate" },
  notebook_missing_extension: { family: "files", stops: "validate" },
  missing_pipeline_source: { family: "files", stops: "deploy" },
  unsupported_pipeline_file: { family: "files", stops: "run" },
  missing_library: { family: "files", stops: "deploy" },
  not_a_notebook: { family: "files", stops: "validate" },
  file_is_a_notebook: { family: "files", stops: "validate" },
  notebook_byte_order_mark: { family: "files", stops: "run" },
  path_is_a_folder: { family: "files", stops: "validate" },
  excluded_from_sync: { family: "files", stops: "run" },
  path_not_checked: { family: "files", stops: "coverage" },
  same_workspace_path: { family: "files", stops: "deploy" },
  file_scan_failed: { family: "files", stops: "coverage" },
  // include
  include_matches_nothing: { family: "include", stops: "silent" },
  resource_not_included: { family: "include", stops: "silent" },
  // Jobs
  unknown_task_dependency: { family: "jobs", stops: "deploy" },
  task_dependency_loop: { family: "jobs", stops: "deploy" },
  duplicate_task_key: { family: "jobs", stops: "silent" },
  duplicate_job_parameter: { family: "jobs", stops: "silent" },
  environment_version_missing: { family: "jobs", stops: "deploy" },
  unknown_environment_key: { family: "jobs", stops: "deploy" },
  environments_not_checked: { family: "jobs", stops: "coverage" },
  project_environment_version_missing: { family: "jobs", stops: "run" },
  project_environment_version_unsupported: { family: "jobs", stops: "run" },
  project_environment_conflict: { family: "jobs", stops: "deploy" },
  multiple_job_triggers: { family: "jobs", stops: "deploy" },
  invalid_job_parameter_name: { family: "jobs", stops: "deploy" },
  invalid_task_key: { family: "jobs", stops: "deploy" },
  outcome_without_condition: { family: "jobs", stops: "deploy" },
  invalid_outcome: { family: "jobs", stops: "deploy" },
  for_each_inputs_not_array: { family: "jobs", stops: "deploy" },
  for_each_inputs_too_long: { family: "jobs", stops: "deploy" },
  unknown_job_parameter: { family: "jobs", stops: "deploy" },
  job_parameter_reference_with_dot: { family: "jobs", stops: "deploy" },
  job_parameter_in_default: { family: "jobs", stops: "deploy" },
  pipeline_selection_not_found: { family: "jobs", stops: "run" },
  job_only_in_target: { family: "jobs", stops: "coverage" },
  // Compute
  runtime_end_of_support: { family: "compute", stops: "advice" },
  // Code in notebooks and files
  widget_not_set: { family: "code", stops: "run" },
  unused_parameter: { family: "code", stops: "advice" },
  sql_parameter_not_set: { family: "code", stops: "run" },
  sql_parameter_quoted: { family: "code", stops: "run" },
  sql_parameter_as_name: { family: "code", stops: "run" },
  schema_renamed_in_target: { family: "code", stops: "run" },
  task_value_unknown_task: { family: "code", stops: "run" },
  task_value_not_upstream: { family: "code", stops: "run" },
  task_value_key_not_set: { family: "code", stops: "run" },
  secret_scope_name_mismatch: { family: "code", stops: "run" },
  run_target_not_found: { family: "code", stops: "run" },
  // Bundle configuration
  missing_bundle_name: { family: "configuration", stops: "deploy" },
  empty_bundle_name_in_root_path: { family: "configuration", stops: "silent" },
  unresolved_variable: { family: "configuration", stops: "validate" },
  variable_reference_loop: { family: "configuration", stops: "validate" },
  resource_key_has_dot: { family: "configuration", stops: "deploy" },
  internal_resource_set: { family: "configuration", stops: "validate" },
  resource_not_defined: { family: "configuration", stops: "validate" },
  variable_in_auth_field: { family: "configuration" },
  variable_in_bundle_name: { family: "configuration", stops: "silent" },
  invalid_engine: { family: "configuration", stops: "validate" },
  terraform_engine_removed: { family: "configuration", stops: "validate" },
  terraform_setting_has_no_effect: { family: "configuration", stops: "advice" },
  script_no_content: { family: "configuration", stops: "validate" },
  variable_in_script_content: { family: "configuration", stops: "validate" },
  script_env_reference_not_resolved: { family: "configuration", stops: "validate" },
  secret_value_not_variable: { family: "configuration" },
  secret_variable_has_default: { family: "configuration" },
  cli_diagnostic: { family: "configuration", stops: "cli" },
  unknown_or_deprecated_field: { family: "configuration", stops: "cli" },
  unknown_task_type: { family: "configuration", stops: "coverage" },
  git_source_not_recommended: { family: "configuration", stops: "deploy" },
  inspector_check_failed: { family: "configuration", stops: "coverage" },
} as const satisfies Record<InspectorIssueKind, CheckInfo>;

/** A check's details. */
export function checkInfo(kind: InspectorIssueKind): CheckInfo {
  return CHECKS[kind];
}
