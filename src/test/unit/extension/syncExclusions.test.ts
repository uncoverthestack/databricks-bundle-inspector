import { describe, test, expect, beforeAll } from "@jest/globals";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
      'Add "../src/ignored.py" to sync.include: .gitignore stops it from being deployed, so it may be missing at run time.',
    );
    expect(issueAt("tasks.nested_gitignored.spark_python_task.python_file")?.title).toBe(
      'Add "../src/nested/nested_ignored.py" to sync.include: src/nested/.gitignore stops it from being deployed, so it may be missing at run time.',
    );
  });

  test("warns about task and pipeline files skipped by sync.exclude", () => {
    expect(issueAt("tasks.sync_excluded.spark_python_task.python_file")?.title).toBe(
      'Change the sync.exclude pattern that matches "../src/excluded/e.py": it stops the file from being deployed, so it may be missing at run time.',
    );
    expect(issueAt("libraries[0].notebook.path")?.title).toBe(
      'Change the sync.exclude pattern that matches "../src/excluded/pipeline_nb.py": it stops the file from being deployed, so it may be missing at run time.',
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

  // #374: a real target's output always has sync.paths, as the CLI fills in ["."] when
  // the bundle sets none (sync_default_path.go). Forms from `bundle validate -o json`,
  // CLI v1.24.0, 2026-11-06.
  test('are checked with sync.paths ["."], the bundle root, which every real target has', async () => {
    const config = fixtureConfig();
    const withDefault = await syncIssues({ ...config, sync: { ...config.sync, paths: ["."] } });
    expect(withDefault).toEqual(issues);
    expect(withDefault.length).toBeGreaterThan(0);
    expect(await syncIssues({ ...config, sync: { ...config.sync, paths: ["./", "src/.."] } })).toEqual(issues);
  });

  test("are not checked when sync.paths moves the sync root", async () => {
    const config = fixtureConfig();
    // A real target writes [".", "../common"] relative to the new root.
    for (const paths of [["sync-exclusions", "common"], [".", "../common"], [".."]]) {
      expect(await syncIssues({ ...config, sync: { ...config.sync, paths } })).toEqual([]);
    }
  });
});

describe("files in .databricks or .git (#514)", () => {
  test("the warning names the folder the file is in", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "always-skipped-"));
    try {
      for (const file of [".databricks/a.py", ".git/b.py"]) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), "print(1)\n");
      }
      const task = (key: string, file: string) => ({ task_key: key, spark_python_task: { python_file: file } });
      const config = {
        bundle: { name: "always_skipped" },
        resources: { jobs: { j: { name: "j", tasks: [task("in_databricks", "./.databricks/a.py"), task("in_git", "./.git/b.py")] } } },
      } as unknown as ParsedBundleConfig;
      const graph = await extractBundleGraph(config, root);
      const titles = buildInspectorIssues(graph, config, [], root)
        .filter((issue) => issue.kind === "excluded_from_sync")
        .map((issue) => `${issue.taskName}: ${issue.title}`)
        .sort();
      expect(titles).toEqual([
        `in_databricks: Move "./.databricks/a.py" out of .databricks: files there aren't deployed, so it may be missing at run time.`,
        `in_git: Move "./.git/b.py" out of .git: files there aren't deployed, so it may be missing at run time.`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
