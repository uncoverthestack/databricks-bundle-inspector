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

// #526, live on CLI v1.27.0 (2026-11-24, twice each): when deploy uploads no file under a
// pipeline glob's folder, the folder isn't in the workspace and the pipeline update fails
// with LIBRARY_FILE_NOT_FOUND. With one file left out of several, the update completed.
describe("a pipeline glob whose files are all left out of the upload (#526)", () => {
  const SQL = "CREATE OR REFRESH MATERIALIZED VIEW a AS SELECT 1;\n";
  const globTitles = async (files: Record<string, string>, sync?: ParsedBundleConfig["sync"], glob = "../src/dlt/**") => {
    const root = mkdtempSync(path.join(tmpdir(), "dbi-glob-sync-"));
    try {
      for (const [relative, text] of Object.entries({ ...files, "resources/p.yml": "resources:\n  pipelines:\n    p:\n      libraries: []\n" })) {
        mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        writeFileSync(path.join(root, relative), text);
      }
      const config = {
        bundle: { name: "globs" },
        include: ["resources/p.yml"],
        ...(sync ? { sync } : {}),
        resources: { pipelines: { p: { libraries: [{ glob: { include: glob } }] } } },
      } as unknown as ParsedBundleConfig;
      const graph = await extractBundleGraph(config, root);
      return buildInspectorIssues(graph, config, [], root)
        .filter((issue) => issue.kind === "excluded_from_sync")
        .map((issue) => `${issue.severity}: ${issue.title}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("every file in .gitignore: a warning naming the sync.include pattern from the bundle root", async () => {
    // `*.sql` matches in every folder; `src/dlt/*.sql` wouldn't reach src/dlt/sub/.
    expect(await globTitles({ ".gitignore": "*.sql\n", "src/dlt/t.sql": SQL, "src/dlt/sub/u.sql": SQL })).toEqual([
      'warning: Add "src/dlt/**" to sync.include: .gitignore stops every file in "../src/dlt/**" from being deployed, so the pipeline may find no source files at run time.',
    ]);
  });

  test("every file matched by sync.exclude", async () => {
    expect(await globTitles({ "src/dlt/t.sql": SQL }, { exclude: ["src/dlt/**"] })).toEqual([
      'warning: Change the sync.exclude pattern that matches the files in "../src/dlt/**": none of them are deployed, so the pipeline may find no source files at run time.',
    ]);
  });

  test("files left out by different rules get one general warning", async () => {
    expect(await globTitles({ ".gitignore": "src/dlt/t.sql\n", "src/dlt/t.sql": SQL, "src/dlt/u.sql": SQL }, { exclude: ["src/dlt/u.sql"] })).toEqual([
      'warning: No file in "../src/dlt/**" is deployed, so the pipeline may find no source files at run time.',
    ]);
  });

  test.each([
    ["a file in a subfolder that src/dlt/*.sql doesn't reach", { ".gitignore": "src/dlt/*.sql\n", "src/dlt/t.sql": SQL, "src/dlt/sub/u.sql": SQL }, undefined],
    ["one file of two ignored", { ".gitignore": "src/dlt/u.sql\n", "src/dlt/t.sql": SQL, "src/dlt/u.sql": SQL }, undefined],
    ["ignored, then brought back by sync.include", { ".gitignore": "src/dlt/\n", "src/dlt/t.sql": SQL }, { include: ["src/dlt/**"] }],
    // Deploy uploads hidden files; the folder exists in the workspace then.
    ["a .gitignore in the folder, which is uploaded itself", { "src/dlt/.gitignore": "*.sql\n", "src/dlt/t.sql": SQL }, undefined],
    ["nothing ignored", { "src/dlt/t.sql": SQL }, undefined],
  ])("no finding: %s", async (_name, files, sync) => {
    expect(await globTitles(files, sync)).toEqual([]);
  });

  test("a folder/* glob is left to other checks: deploy refuses it whatever its files", async () => {
    expect(await globTitles({ ".gitignore": "src/dlt/*.sql\n", "src/dlt/t.sql": SQL }, undefined, "../src/dlt/*")).toEqual([]);
  });
});

// #531, live on CLI v1.27.0 (2026-11-24, twice each): deploy uploads every file under a
// glob's folder, and the pipeline update fails on some of them next to a valid .sql file.
describe("deployed files a pipeline glob refuses (#531)", () => {
  const SQL = "CREATE OR REFRESH MATERIALIZED VIEW a AS SELECT 1;\n";
  const findings = async (files: Record<string, string>, sync?: ParsedBundleConfig["sync"]) => {
    const root = mkdtempSync(path.join(tmpdir(), "dbi-glob-types-"));
    try {
      for (const [relative, text] of Object.entries({ ...files, "src/dlt/t.sql": SQL, "resources/p.yml": "resources:\n  pipelines:\n    p:\n      libraries: []\n" })) {
        mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        writeFileSync(path.join(root, relative), text);
      }
      const config = {
        bundle: { name: "types" },
        include: ["resources/p.yml"],
        ...(sync ? { sync } : {}),
        resources: { pipelines: { p: { libraries: [{ glob: { include: "../src/dlt/**" } }] } } },
      } as unknown as ParsedBundleConfig;
      const graph = await extractBundleGraph(config, root);
      return buildInspectorIssues(graph, config, [], root)
        .filter((issue) => issue.kind === "unsupported_pipeline_file")
        .map((issue) => `${issue.severity}: ${issue.title}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test.each([
    ".gitkeep", ".DS_Store", ".env", ".gitignore", "Makefile", "sub/.gitkeep",
    "x.scala", "schema.yml", "conf.yaml", "pyproject.toml", "setup.cfg", "app.ini", "uv.lock",
    "a-0.1-py3-none-any.whl", "img.png", "page.html", "run.sh", "X.java", "x.r", "y.R",
  ])("%s fails the update", async (file) => {
    const shown = `src/dlt/${file}`;
    expect(await findings({ [`src/dlt/${file}`]: "x\n" })).toEqual([
      `error: Add "${shown}" to sync.exclude: deployed under "../src/dlt/**", it may fail the pipeline, which only takes .py and .sql files.`,
    ]);
  });

  test("several files are counted in one finding", async () => {
    expect(await findings({ "src/dlt/.gitkeep": "", "src/dlt/.DS_Store": "x", "src/dlt/Makefile": "x", "src/dlt/README.md": "x" })).toEqual([
      'error: Add "src/dlt/.DS_Store" and 2 other files to sync.exclude: deployed under "../src/dlt/**", it may fail the pipeline, which only takes .py and .sql files.',
    ]);
  });

  test.each(["README.md", "notes.txt", "data.csv", "config.json", "nb.ipynb", "helpers.py", ".hidden.py"])(
    "%s is skipped by the pipeline: no finding",
    async (file) => {
      expect(await findings({ [`src/dlt/${file}`]: "x\n" })).toEqual([]);
    },
  );

  test("a file left out of the upload is no finding", async () => {
    expect(await findings({ "src/dlt/.gitkeep": "" }, { exclude: ["src/dlt/.gitkeep"] })).toEqual([]);
    expect(await findings({ "src/dlt/.DS_Store": "x", ".gitignore": ".DS_Store\n" })).toEqual([]);
  });
});
