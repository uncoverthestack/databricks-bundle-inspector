/**
 * The words a problem is shown under, by its `kind`: its short name, and the group it is
 * listed in under Issues. Shared by the panel and the command-line tool (#348, #392).
 */

const KIND_LABELS: Record<string, string> = {
  missing_file: "Missing file",
  notebook_missing_extension: "Notebook path without extension",
  missing_pipeline_source: "Missing pipeline source",
  unsupported_pipeline_file: "Not a pipeline source",
  missing_library: "Missing local library",
  unresolved_variable: "Unresolved variable",
  cli_diagnostic: "Databricks CLI",
  unknown_or_deprecated_field: "Unknown field",
  unknown_task_type: "Unrecognised task type",
  git_source_not_recommended: "Git source warning",
  secret_scope_name_mismatch: "Secret scope name",
  not_a_notebook: "Not a notebook",
  file_is_a_notebook: "File is a notebook",
  path_is_a_folder: "Path is a folder",
  widget_not_set: "Widget not set",
  unused_parameter: "Unused parameter",
  sql_parameter_not_set: "SQL parameter not set",
  sql_parameter_quoted: "SQL parameter quoted twice",
  pipeline_selection_not_found: "Pipeline selection",
  runtime_end_of_support: "Runtime support",
  schema_renamed_in_target: "Schema renamed",
  task_value_unknown_task: "Task value",
  task_value_not_upstream: "Task value",
  task_value_key_not_set: "Task value",
  excluded_from_sync: "Not deployed",
  path_not_checked: "Not checked",
  job_only_in_target: "Not checked",
  same_workspace_path: "Same workspace path",
  include_matches_nothing: "Include pattern",
  resource_not_included: "Not included",
  missing_bundle_name: "Bundle name",
  empty_bundle_name_in_root_path: "Bundle name",
};

const GROUP_NAMES: Record<string, string> = {
  missing_file: "Missing Files",
  notebook_missing_extension: "Notebook Paths Without Extension",
  missing_pipeline_source: "Missing Pipeline Sources",
  unsupported_pipeline_file: "Files Pipelines Refuse",
  missing_library: "Missing Libraries",
  unresolved_variable: "Unresolved Variables",
  cli_diagnostic: "Databricks CLI",
  unknown_or_deprecated_field: "Unknown or Deprecated Fields",
  unknown_task_type: "Unrecognised Task Types",
  git_source_not_recommended: "Git Source Warnings",
  secret_scope_name_mismatch: "Secret Scope Names",
  not_a_notebook: "Not Notebooks",
  file_is_a_notebook: "Files That Are Notebooks",
  path_is_a_folder: "Paths That Are Folders",
  widget_not_set: "Widgets Not Set",
  unused_parameter: "Unused Parameters",
  sql_parameter_not_set: "SQL Parameters Not Set",
  sql_parameter_quoted: "SQL Parameters Quoted Twice",
  pipeline_selection_not_found: "Pipeline Selections Not Found",
  runtime_end_of_support: "Runtime End of Support",
  schema_renamed_in_target: "Schemas Renamed in Targets",
  task_value_unknown_task: "Task Values",
  task_value_not_upstream: "Task Values",
  task_value_key_not_set: "Task Values",
  excluded_from_sync: "Files Not Deployed",
  path_not_checked: "Paths Not Checked",
  job_only_in_target: "Jobs Not Checked",
  same_workspace_path: "Same Workspace Paths",
  include_matches_nothing: "Include Patterns",
  resource_not_included: "Resource Files Not Included",
  missing_bundle_name: "Bundle Name",
  empty_bundle_name_in_root_path: "Bundle Name",
};

/** A problem's short name, such as `Missing file`. */
export function issueKindLabel(kind: string | undefined): string {
  return (kind !== undefined && Object.hasOwn(KIND_LABELS, kind) ? KIND_LABELS[kind] : undefined) ?? "Issue";
}

/** The Issues group a problem is listed in, such as `Missing Files`. */
export function issueGroupName(kind: string | undefined): string {
  return (kind !== undefined && Object.hasOwn(GROUP_NAMES, kind) ? GROUP_NAMES[kind] : undefined) ?? "Issues";
}

/** Every kind with its own name and group, for the test that keeps the two lists the same. */
export const NAMED_ISSUE_KINDS: readonly string[] = Object.keys(KIND_LABELS);
export const GROUPED_ISSUE_KINDS: readonly string[] = Object.keys(GROUP_NAMES);
