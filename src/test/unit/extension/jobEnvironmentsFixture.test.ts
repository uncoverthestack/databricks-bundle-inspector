import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

// The job-environments fixture through the inspector, from the Databricks CLI's own output
// for the structural preview. See the fixture's README for what deploy and run did with
// each case (CLI v1.26.0, 2026-11-12).
const ROOT = path.resolve("src/test/fixtures/job-environments");
const KINDS = new Set(["environment_version_missing", "unknown_environment_key", "project_environment_version_missing", "notebook_environment_not_set"]);

/** `file: line text` for each finding, so a test reads the line it points at. */
async function findings() {
  const bundle = JSON.parse(readFileSync(path.join(ROOT, "validated-bundle.json"), "utf8")) as ParsedBundleConfig;
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(bundle, ROOT));
  return buildInspectorIssues(graph, bundle, [], ROOT)
    .filter((issue) => KINDS.has(issue.kind))
    .map((issue) => {
      // Forward slashes on every OS, so the expected paths read the same on Windows.
      const file = path.relative(ROOT, issue.file ?? "").split(path.sep).join("/");
      const text = readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/)[issue.line! - 1]!.trim();
      return { kind: issue.kind, severity: issue.severity, task: issue.taskName, at: `${file}: ${text}`, title: issue.title };
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

describe("job-environments fixture", () => {
  test("the structural preview reports each broken case at its line, and no clean case", async () => {
    expect(await findings()).toEqual(
      [
        {
          kind: "environment_version_missing",
          severity: "error",
          task: undefined,
          at: "resources/job.yml: - environment_key: deps_only",
          title: 'Environment "deps_only" has no version. Deploy may fail.',
        },
        {
          kind: "environment_version_missing",
          severity: "error",
          task: undefined,
          at: "resources/job.yml: - environment_key: empty",
          title: 'Environment "empty" has no version. Deploy may fail.',
        },
        {
          kind: "environment_version_missing",
          severity: "error",
          task: undefined,
          at: "resources/job.yml: - environment_key: no_spec",
          title: 'Environment "no_spec" has no version. Deploy may fail.',
        },
        {
          kind: "project_environment_version_missing",
          severity: "error",
          task: undefined,
          at: "resources/job.yml: project_environment: ../projects/pyproject.toml",
          title: 'Environment "project": its pyproject.toml has no environment version. The job may fail when it runs.',
        },
        {
          kind: "unknown_environment_key",
          severity: "error",
          task: "typo",
          at: "resources/job.yml: environment_key: versoin",
          title: 'Environment "versoin" may not exist. Did you mean "version"?',
        },
        {
          kind: "notebook_environment_not_set",
          severity: "info",
          task: undefined,
          at: "resources/job.yml: envs:",
          title: 'Job "envs" has notebook task "notebook" with no environment version. Databricks may change it.',
        },
        {
          kind: "unknown_environment_key",
          severity: "error",
          task: "loop",
          at: "resources/job.yml: environment_key: bse",
          title: 'Environment "bse" may not exist. Did you mean "base"?',
        },
      ].sort((a, b) => a.at.localeCompare(b.at)),
    );
  });
});
