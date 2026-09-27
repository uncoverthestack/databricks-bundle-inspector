import { describe, test, expect, beforeAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import {
  extractBundleGraph,
  type ParsedBundleConfig,
} from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues, type InspectorIssue } from "../../../bundle/issues.js";

const bundleRoot = path.resolve(__dirname, "../../fixtures/sync-exclusions");

const RESOURCE_FILES = [
  "resources/sync_exclusions.job.yml",
  "resources/git_sourced.job.yml",
  "resources/sync_exclusions.pipeline.yml",
];

function readYaml<T>(file: string): T {
  return parse(readFileSync(path.join(bundleRoot, file), "utf8")) as T;
}

// Without a target, `databricks bundle validate -o json` returns these paths and the
// sync block unchanged (checked on CLI v1.17.0), so the fixture YAML stands in for it.
function fixtureConfig(overrides: Partial<ParsedBundleConfig> = {}): ParsedBundleConfig {
  const resources: Record<string, Record<string, unknown>> = {};
  for (const file of RESOURCE_FILES) {
    const parsed = readYaml<{ resources: Record<string, Record<string, unknown>> }>(file);
    for (const [group, entries] of Object.entries(parsed.resources)) {
      resources[group] = { ...resources[group], ...entries };
    }
  }
  const root = readYaml<{ sync: ParsedBundleConfig["sync"] }>("databricks.yml");
  return {
    bundle: { name: "sync_exclusions" },
    include: RESOURCE_FILES,
    sync: root.sync,
    resources,
    ...overrides,
  } as ParsedBundleConfig;
}

async function syncIssues(config: ParsedBundleConfig): Promise<InspectorIssue[]> {
  const graph = await extractBundleGraph(config, bundleRoot);
  return buildInspectorIssues(graph, config, [], bundleRoot).filter(
    (issue) => issue.kind === "excluded_from_sync",
  );
}

describe("files excluded from sync", () => {
  let issues: InspectorIssue[];

  beforeAll(async () => {
    issues = await syncIssues(fixtureConfig());
  });

  function issueAt(yamlPathEnd: string): InspectorIssue | undefined {
    return issues.find((issue) => issue.yamlPath?.endsWith(yamlPathEnd));
  }

  // Expected values match `databricks bundle sync --dry-run`; see the fixture README.
  test("warns about task files skipped by .gitignore, naming the .gitignore", () => {
    expect(issueAt("tasks.gitignored.spark_python_task.python_file")?.title).toBe(
      '"../src/ignored.py" may not be deployed: it matches .gitignore.',
    );
    expect(issueAt("tasks.nested_gitignored.spark_python_task.python_file")?.title).toBe(
      '"../src/nested/nested_ignored.py" may not be deployed: it matches src/nested/.gitignore.',
    );
  });

  test("warns about task and pipeline files skipped by sync.exclude", () => {
    expect(issueAt("tasks.sync_excluded.spark_python_task.python_file")?.title).toBe(
      '"../src/excluded/e.py" may not be deployed: it matches sync.exclude.',
    );
    expect(issueAt("libraries[0].notebook.path")?.title).toBe(
      '"../src/excluded/pipeline_nb.py" may not be deployed: it matches sync.exclude.',
    );
  });

  test("files added back by sync.include, kept files and git-sourced jobs have no issue", () => {
    expect(issueAt("tasks.readded_by_include.spark_python_task.python_file")).toBeUndefined();
    expect(issueAt("tasks.kept.spark_python_task.python_file")).toBeUndefined();
    expect(issueAt("tasks.from_git.spark_python_task.python_file")).toBeUndefined();
    expect(issues).toHaveLength(4);
  });

  test("are warnings, since bundle validate passes", () => {
    expect(issues.every((issue) => issue.severity === "warning")).toBe(true);
  });

  test("are not checked when sync.paths changes what is synced", async () => {
    const config = fixtureConfig();
    expect(
      await syncIssues({ ...config, sync: { ...config.sync, paths: ["."] } }),
    ).toEqual([]);
  });
});
