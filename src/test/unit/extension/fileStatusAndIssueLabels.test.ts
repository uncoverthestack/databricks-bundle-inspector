import { describe, expect, test } from "@jest/globals";
import { fileStatusKey, hasTemplate, isRemotePath } from "../../../bundle/fileStatus.js";
import { isRemotePath as taskIsRemotePath } from "../../../bundle/resources/task.js";
import { GROUPED_ISSUE_KINDS, issueGroupName, issueKindLabel, NAMED_ISSUE_KINDS } from "../../../bundle/issueLabels.js";
import { INSPECTOR_ISSUE_KINDS } from "../../../bundle/issues.js";

describe("file status (#392)", () => {
  test.each([
    ["${var.root}/nb.py", {}, "template"],
    ["{{job.id}}/nb.py", { resolvedPath: "/b/x", exists: false }, "template"],
    ["/Workspace/Shared/nb", { resolvedPath: "/b/x", exists: false }, "remote"],
    ["dbfs:/libs/a.whl", {}, "remote"],
    ["s3://bucket/a.jar", {}, "remote"],
    ["abfss://c@acct.dfs.core.windows.net/a", {}, "remote"],
    ["gs://bucket/a", {}, "remote"],
    ["/Users/me@example.com/nb", { resolvedPath: "/b/x", exists: false }, "remote"],
    ["/Shared/existing_notebook", {}, "remote"],
    ["/Repos/team/repo/nb", {}, "remote"],
    ["/Volumes/main/raw/code/job.py", {}, "remote"],
    ["./nb.py", { resolvedPath: "/b/nb.py", exists: false }, "missing"],
    ["./nb.py", { resolvedPath: "/b/nb.py", exists: true }, "found"],
    ["./nb.py", { exists: true }, "found"],
    ["./nb.py", {}, "unknown"],
    [undefined, {}, "unknown"],
  ] as const)("%s %j is %s", (path, rest, key) => {
    expect(fileStatusKey({ path, ...rest })).toBe(key);
  });

  test("a variable is checked before the remote prefixes", () => {
    expect(isRemotePath("/Workspace/${var.x}")).toBe(true);
    expect(hasTemplate("/Workspace/${var.x}")).toBe(true);
    expect(fileStatusKey({ path: "/Workspace/${var.x}" })).toBe("template");
  });

  test("the graph, the panel and the export use one rule (#455)", () => {
    expect(taskIsRemotePath).toBe(isRemotePath);
  });

  test("a workspace path needs the /Workspace/ folder, not just the word", () => {
    expect(isRemotePath("/Workspaces/x")).toBe(false);
    expect(isRemotePath("Workspace/x")).toBe(false);
  });
});

describe("problem names and Issues groups (#392)", () => {
  test("known kinds have their own name and group", () => {
    expect(issueKindLabel("missing_file")).toBe("Missing file");
    expect(issueGroupName("missing_file")).toBe("Missing Files");
    expect(issueGroupName("task_value_key_not_set")).toBe("Task Values");
  });

  test("an unknown or missing kind falls back, including names an object already has", () => {
    for (const kind of [undefined, "", "nope", "toString", "constructor", "__proto__"]) {
      expect(issueKindLabel(kind)).toBe("Issue");
      expect(issueGroupName(kind)).toBe("Issues");
    }
  });

  test("every kind with a name has a group, and the other way round", () => {
    expect([...NAMED_ISSUE_KINDS].sort()).toEqual([...GROUPED_ISSUE_KINDS].sort());
  });

  test("every named kind is one the checks report", () => {
    expect(NAMED_ISSUE_KINDS.filter((kind) => !(INSPECTOR_ISSUE_KINDS as readonly string[]).includes(kind))).toEqual([]);
  });

  // These kinds are listed under the plain "Issues" group today. A new kind must either get
  // a name and group, or be added here on purpose.
  test("the kinds still shown under the plain Issues group", () => {
    expect(INSPECTOR_ISSUE_KINDS.filter((kind) => !NAMED_ISSUE_KINDS.includes(kind))).toEqual([
      "unknown_task_dependency",
      "task_dependency_loop",
      "duplicate_task_key",
      "duplicate_job_parameter",
      "environment_version_missing",
      "unknown_environment_key",
      "project_environment_version_missing",
      "multiple_job_triggers",
      "invalid_job_parameter_name",
      "invalid_task_key",
      "outcome_without_condition",
      "invalid_outcome",
      "for_each_inputs_not_array",
      "for_each_inputs_too_long",
      "unknown_job_parameter",
      "job_parameter_reference_with_dot",
      "job_parameter_in_default",
      "run_target_not_found",
      "variable_reference_loop",
      "internal_resource_set",
      "resource_not_defined",
      "variable_in_auth_field",
      "variable_in_bundle_name",
      "invalid_engine",
      "terraform_engine_removed",
      "terraform_setting_has_no_effect",
      "script_no_content",
      "variable_in_script_content",
      "script_env_reference_not_resolved",
      "secret_value_not_variable",
      "secret_variable_has_default",
    ]);
  });
});
