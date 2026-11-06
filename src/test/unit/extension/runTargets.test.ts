import { beforeAll, describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues, type InspectorIssue } from "../../../bundle/issues.js";
import { checkRunTarget } from "../../../bundle/runTargets.js";

// One task per case; the run results are in the fixture's README (a serverless job run
// on Databricks CLI v1.24.0). Without a target `bundle validate -o json` returns these
// paths unchanged, so the fixture YAML stands in for the CLI output.
const bundleRoot = path.resolve(__dirname, "../../fixtures/run-targets");
const jobs = path.join(bundleRoot, "src/jobs");

function fixtureConfig(): ParsedBundleConfig {
  const job = parse(readFileSync(path.join(bundleRoot, "resources/run_targets.job.yml"), "utf8")) as {
    resources: Record<string, Record<string, unknown>>;
  };
  return { bundle: { name: "run_targets" }, include: ["resources/*.yml"], resources: job.resources } as ParsedBundleConfig;
}

let issues: InspectorIssue[];

beforeAll(async () => {
  const config = fixtureConfig();
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, bundleRoot));
  issues = buildInspectorIssues(graph, config, [], bundleRoot).filter(
    (issue) => issue.kind === "run_target_not_found" || (issue.kind === "excluded_from_sync" && issue.id.startsWith("run-target:")),
  );
});

/** Per task: the finding's code and title, or nothing. */
function finding(task: string) {
  const found = issues.filter((issue) => issue.taskName === task);
  return found.map((issue) => [issue.kind, issue.title]);
}

describe("%run and dbutils.notebook.run targets", () => {
  test("a missing target fails the run", () => {
    expect(finding("run_missing")).toEqual([["run_target_not_found", '%run target "./missing_helper" may not exist.']]);
    expect(finding("nbrun_missing")).toEqual([
      ["run_target_not_found", 'dbutils.notebook.run target "./missing_child" may not exist.'],
    ]);
    expect(finding("nbrun_keyword")).toEqual([
      ["run_target_not_found", 'dbutils.notebook.run target "./missing_child" may not exist.'],
    ]);
  });

  test("a quoted path is checked without its quotes", () => {
    expect(finding("run_quoted")).toEqual([]);
    expect(finding("run_quoted_missing")).toEqual([["run_target_not_found", '%run target "./missing_helper" may not exist.']]);
  });

  test("a close name in the same folder is offered", () => {
    expect(finding("run_typo")).toEqual([
      ["run_target_not_found", '%run target "./helper_bn" may not exist. Did you mean "./helper_nb"?'],
    ]);
  });

  test("a plain file or a folder is not a notebook", () => {
    expect(finding("run_plain_file")).toEqual([["run_target_not_found", '%run target "./helper_plain" may be a file, not a notebook.']]);
    expect(finding("nbrun_plain_file")).toEqual([
      ["run_target_not_found", 'dbutils.notebook.run target "./helper_plain" may be a file, not a notebook.'],
    ]);
    expect(finding("run_folder")).toEqual([["run_target_not_found", '%run target "./somefolder" may be a folder, not a notebook.']]);
  });

  test("a notebook that isn't uploaded gets excluded_from_sync", () => {
    expect(finding("run_gitignored")).toEqual([["excluded_from_sync", '"./ignored_nb" may not be deployed: it matches .gitignore.']]);
  });

  test("notebooks that run are not reported: with or without extension, ../, SQL and .ipynb", () => {
    for (const task of ["run_ok", "run_with_ext", "run_parent", "run_sql_nb", "run_ipynb", "nbrun_ok", "nbrun_with_ext", "nbrun_parent"]) {
      expect({ task, found: finding(task) }).toEqual({ task, found: [] });
    }
  });

  test("paths that can't be checked offline, comments and other objects are not reported", () => {
    for (const task of ["run_absolute", "run_bare", "run_commented", "nbrun_dynamic", "nbrun_other_object"]) {
      expect({ task, found: finding(task) }).toEqual({ task, found: [] });
    }
  });

  test("the finding is at the line in the notebook, with the task", () => {
    const [issue] = issues.filter((i) => i.taskName === "run_missing");
    expect(issue).toMatchObject({ severity: "error", file: path.join(jobs, "run_missing.py"), line: 2 });
    const [nbrun] = issues.filter((i) => i.taskName === "nbrun_missing");
    expect(nbrun).toMatchObject({ file: path.join(jobs, "nbrun_missing.py"), line: 2 });
  });
});

describe("checkRunTarget", () => {
  const from = path.join(jobs, "run_ok.py");
  test.each([
    ["./helper_nb", "notebook"],
    ["./helper_nb.py", "notebook"],
    ["../shared/shared_nb", "notebook"],
    ["./missing_helper", "missing"],
    ["./helper_plain", "file"],
    ["./helper_plain.py", "file"],
    ["./somefolder", "folder"],
    ["/Workspace/Shared/x", "unchecked"],
    ["helper_nb", "unchecked"],
    ['"./helper_nb"', "notebook"],
    ["'./missing_helper'", "missing"],
  ])("%s is %s", (target, status) => {
    expect(checkRunTarget(from, target).status).toBe(status);
  });

  test("a path built at run time is unchecked", () => {
    expect(checkRunTarget(from, null).status).toBe("unchecked");
  });
});
