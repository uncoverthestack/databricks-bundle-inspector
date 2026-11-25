import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ignore from "ignore";
import {
  extractBundleGraph,
  type ParsedBundleConfig,
} from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import {
  classifyChange,
  collectWatchSpec,
  filesOutsideRoot,
  foldersOutsideRoot,
  matchesGlobPattern,
  type BundleWatchSpec,
} from "../../../bundle/watchedFiles.js";

const bundleRoot = path.resolve(
  __dirname,
  "../../fixtures/pre-release-qa/edge-cases",
);

// `databricks bundle validate -o json` output for the fixture (CLI v1.17.0, probe target),
// trimmed to the fields the watch list reads.
const config: ParsedBundleConfig = {
  bundle: { name: "pre_release_qa_edge_cases" },
  include: [
    "resources/jobs/yaml_edge_job.job.yml",
    "resources/pipelines/pipeline_from_nested_yaml.pipeline.yml",
  ],
  resources: {
    jobs: {
      yaml_edge_job: {
        tasks: [
          {
            task_key: "generate_items",
            spark_python_task: { python_file: "../../src/tasks/generate_items.py" },
          },
          {
            task_key: "process_each_item",
            depends_on: [{ task_key: "generate_items" }],
            for_each_task: {
              inputs: "{{tasks.generate_items.values.items}}",
              task: {
                task_key: "process_one_item",
                spark_python_task: {
                  python_file: "../../src/tasks/missing_process_item.py",
                },
              },
            },
          },
          {
            task_key: "workspace_notebook",
            notebook_task: {
              notebook_path: "/Workspace/Users/qa@example.com/shared_notebook",
              source: "WORKSPACE",
            },
          },
        ],
      },
    },
    pipelines: {
      pipeline_from_nested_yaml: {
        libraries: [{ glob: { include: "../../src/dlt/**" } }],
      },
    },
  },
} as ParsedBundleConfig;

let spec: BundleWatchSpec;

beforeAll(async () => {
  const graph = await extractBundleGraph(config, bundleRoot);
  spec = collectWatchSpec(graph, config, bundleRoot, ["resources/**/*.yml"]);
});

// Relative path with "/" on every OS, so expectations read the same on Windows.
function posixRelative(file: string): string {
  return path.relative(bundleRoot, file).split(path.sep).join("/");
}

function at(rel: string): string {
  return path.join(bundleRoot, rel);
}

describe("collectWatchSpec", () => {
  test("watches the bundle files, task sources and pipeline folders the bundle points at", () => {
    expect(
      [...spec.files].map(posixRelative).sort(),
    ).toEqual([
      "databricks.yaml",
      "databricks.yml",
      "resources/jobs/yaml_edge_job.job.yml",
      "resources/pipelines/pipeline_from_nested_yaml.pipeline.yml",
      "src/tasks/generate_items.py",
      "src/tasks/missing_process_item.py",
    ]);
    expect(spec.folders.map(posixRelative)).toEqual([
      "src/dlt",
    ]);
    expect(filesOutsideRoot(spec)).toEqual([]);
  });
});

describe("classifyChange", () => {
  test("re-checks when the missing for_each file is created", () => {
    expect(classifyChange(spec, at("src/tasks/missing_process_item.py"))).toBe("source");
  });

  test("treats bundle YAML, including new files matching include, as config", () => {
    expect(classifyChange(spec, at("databricks.yml"))).toBe("config");
    expect(classifyChange(spec, at("resources/jobs/new.job.yml"))).toBe("config");
  });

  test("re-checks when a file under a pipeline glob folder changes", () => {
    expect(classifyChange(spec, at("src/dlt/silver.py"))).toBe("source");
  });

  test("re-checks when a folder holding referenced files is deleted", () => {
    expect(classifyChange(spec, at("src/tasks"))).toBe("source");
    expect(classifyChange(spec, at("resources"))).toBe("config");
  });

  test("ignores files the bundle does not point at, including CLI state", () => {
    expect(classifyChange(spec, at("README.md"))).toBeUndefined();
    expect(classifyChange(spec, at("src/tasks/unrelated.py"))).toBeUndefined();
    expect(classifyChange(spec, at(".databricks/.gitignore"))).toBeUndefined();
    expect(classifyChange(spec, bundleRoot)).toBeUndefined();
  });

  test("matches a notebook referenced without its extension", () => {
    const notebookSpec: BundleWatchSpec = {
      ...spec,
      files: new Set([at("src/notebooks/ingest")]),
      folders: [],
    };
    expect(classifyChange(notebookSpec, at("src/notebooks/ingest.ipynb"))).toBe("source");
  });

  describe("where the file system ignores letter case", () => {
    const respelled = (rel: string) => at(rel).toUpperCase();

    test("recognises the bundle's files under another spelling", () => {
      const relaxed: BundleWatchSpec = { ...spec, ignoresCase: true };
      expect(classifyChange(relaxed, respelled("src/tasks/generate_items.py"))).toBe("source");
      expect(classifyChange(relaxed, respelled("databricks.yml"))).toBe("config");
      expect(classifyChange(relaxed, respelled("resources/jobs/new.job.yml"))).toBe("config");
      expect(classifyChange(relaxed, respelled("src/dlt/silver.py"))).toBe("source");
      expect(classifyChange(relaxed, respelled("src/tasks"))).toBe("source");
    });

    test("still ignores files the bundle does not point at", () => {
      const relaxed: BundleWatchSpec = { ...spec, ignoresCase: true };
      expect(classifyChange(relaxed, respelled("README.md"))).toBeUndefined();
      expect(classifyChange(relaxed, respelled("src/tasks/unrelated.py"))).toBeUndefined();
      expect(classifyChange(relaxed, bundleRoot.toUpperCase())).toBeUndefined();
    });

    test("passes the sync rules the root as the bundle spells it", () => {
      const asked: string[] = [];
      const relaxed: BundleWatchSpec = {
        ...spec,
        ignoresCase: true,
        isSynced: (file) => {
          asked.push(file);
          return true;
        },
      };
      expect(classifyChange(relaxed, bundleRoot.toUpperCase() + "/src/dlt/Silver.py")).toBe("source");
      expect(asked).toEqual([bundleRoot + "/src/dlt/Silver.py"]);
    });

    test("matches a Windows drive letter written in the other case", () => {
      const windows: BundleWatchSpec = {
        bundleRoot: "c:\\projects\\orders_etl",
        files: new Set(["c:\\projects\\orders_etl\\src\\publish_metrics.py"]),
        folders: [],
        patterns: [],
        includes: ignore(),
        isSynced: () => true,
        ignoresCase: true,
      };
      const reported = "C:\\Projects\\orders_etl\\src\\publish_metrics.py";
      expect(classifyChange(windows, reported)).toBe("source");
      expect(classifyChange({ ...windows, ignoresCase: false }, reported)).toBeUndefined();
    });
  });

  test("keeps letter case apart where the file system does (Linux)", () => {
    expect(spec.ignoresCase).toBe(false);
    expect(classifyChange(spec, at("src/tasks/Generate_Items.py"))).toBeUndefined();
    expect(classifyChange(spec, at("databricks.yml").toUpperCase())).toBeUndefined();
  });

  test("ignores files in a pipeline folder that sync would skip", () => {
    const syncSpec: BundleWatchSpec = {
      ...spec,
      includes: ignore(),
      isSynced: (file) => !file.includes("__pycache__"),
    };
    expect(classifyChange(syncSpec, at("src/dlt/__pycache__/bronze.pyc"))).toBeUndefined();
    expect(classifyChange(syncSpec, at("src/dlt/bronze.py"))).toBe("source");
  });
});

describe("classifyChange: folders whose name starts with ..", () => {
  test("a new YAML file in a child folder named ..resources is bundle config", async () => {
    const root = path.resolve("/workspace/dotdot");
    const minimal: ParsedBundleConfig = { bundle: { name: "dotdot" } } as ParsedBundleConfig;
    const dotSpec = collectWatchSpec(await extractBundleGraph(minimal, root), minimal, root, ["..resources/*.yml"]);
    expect(classifyChange(dotSpec, path.join(root, "..resources", "new.yml"))).toBe("config");
    // A file above the bundle stays outside it.
    expect(classifyChange(dotSpec, path.join(root, "..", "resources", "new.yml"))).toBeUndefined();
  });
});

describe("notebooks a task's notebook runs, and files that share a workspace path", () => {
  // A temporary bundle on disk, since both rules read the files there.
  let root: string;
  let spec: BundleWatchSpec;
  const header = "# Databricks notebook source\n";

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "dbi-watch-run-"));
    mkdirSync(path.join(root, "lib"));
    writeFileSync(path.join(root, "parent.py"), `${header}# MAGIC %run ./lib/child\n# COMMAND ----------\n# MAGIC %run ./not_yet\n# COMMAND ----------\ndbutils.notebook.run("./later", 60)\n`);
    writeFileSync(path.join(root, "lib", "child.py"), `${header}# MAGIC %run ./grandchild\n`);
    writeFileSync(path.join(root, "lib", "grandchild.py"), `${header}dbutils.widgets.get("x")\n`);
    writeFileSync(path.join(root, "pair.py"), header);
    writeFileSync(path.join(root, "pair.sql"), "-- Databricks notebook source\n");
    writeFileSync(path.join(root, "alone.py"), header);
    mkdirSync(path.join(root, "folder_twin"));
    writeFileSync(path.join(root, "folder_twin.py"), header);
    const bundle: ParsedBundleConfig = {
      bundle: { name: "watch-run" },
      resources: { jobs: { job: { tasks: [{ task_key: "t", notebook_task: { notebook_path: "./parent.py" } }] } } },
    } as unknown as ParsedBundleConfig;
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(bundle, root));
    spec = collectWatchSpec(graph, bundle, root, []);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("saving a %run notebook, at any depth, re-checks", () => {
    expect(classifyChange(spec, path.join(root, "lib", "child.py"))).toBe("source");
    expect(classifyChange(spec, path.join(root, "lib", "grandchild.py"))).toBe("source");
  });

  test("creating a %run or notebook.run notebook that was missing re-checks", () => {
    expect(classifyChange(spec, path.join(root, "not_yet.py"))).toBe("source");
    expect(classifyChange(spec, path.join(root, "later.ipynb"))).toBe("source");
  });

  test("a new notebook beside one with the same name and another extension re-checks, either way round", () => {
    expect(classifyChange(spec, path.join(root, "pair.sql"))).toBe("source");
    expect(classifyChange(spec, path.join(root, "pair.py"))).toBe("source");
  });

  test("a notebook beside a folder of the same name re-checks, and the folder too", () => {
    expect(classifyChange(spec, path.join(root, "folder_twin.py"))).toBe("source");
    expect(classifyChange(spec, path.join(root, "folder_twin"))).toBe("source");
  });

  test("an unreferenced file with nothing sharing its path does not", () => {
    expect(classifyChange(spec, path.join(root, "alone.py"))).toBeUndefined();
    expect(classifyChange(spec, path.join(root, "notes.md"))).toBeUndefined();
  });
});

describe("files the checks read that weren't watched (issue 590)", () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

  /** A temp folder with these files, the bundle in `bundleDir` under it, and its watch spec. */
  async function specFor(files: Record<string, string>, resources: Record<string, unknown>, bundleDir = ".") {
    const top = mkdtempSync(path.join(os.tmpdir(), "watch-590-"));
    roots.push(top);
    // Its own git folder, so the sync rules don't read the folders above.
    mkdirSync(path.join(top, ".git"));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(top, name)), { recursive: true });
      writeFileSync(path.join(top, name), text);
    }
    const root = path.join(top, bundleDir);
    mkdirSync(root, { recursive: true });
    const bundleConfig = { bundle: { name: "w" }, resources } as unknown as ParsedBundleConfig;
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(bundleConfig, root));
    return { top, root, spec: collectWatchSpec(graph, bundleConfig, root, []) };
  }
  const pythonTask = (extra: Record<string, unknown> = {}) => ({
    task_key: "t",
    spark_python_task: { python_file: "./main.py" },
    ...extra,
  });

  test("creating a wheel a library glob matches re-checks; a file it doesn't match doesn't", async () => {
    const { root, spec } = await specFor(
      { "main.py": "print(1)\n", ".gitignore": "dist/\n" },
      { jobs: { j: { name: "j", tasks: [pythonTask({ libraries: [{ whl: "./dist/*.whl" }] })] } } },
    );
    // Even though .gitignore skips dist/: deploy uploads libraries anyway.
    expect(classifyChange(spec, path.join(root, "dist", "new.whl"))).toBe("source");
    expect(classifyChange(spec, path.join(root, "dist", "notes.txt"))).toBeUndefined();
    // `*` doesn't cross a folder, as in the CLI's Go glob.
    expect(classifyChange(spec, path.join(root, "dist", "sub", "new.whl"))).toBeUndefined();
  });

  test("editing a project_environment file, or building an environment dependency, re-checks", async () => {
    const { root, spec } = await specFor(
      { "main.py": "print(1)\n", "pyproject.toml": "[project]\nname = \"demo\"\n" },
      {
        jobs: {
          j: {
            name: "j",
            tasks: [pythonTask({ environment_key: "e" }), { ...pythonTask({ environment_key: "d" }), task_key: "u" }],
            environments: [
              { environment_key: "e", spec: { project_environment: "./pyproject.toml" } },
              { environment_key: "d", spec: { environment_version: "4", dependencies: ["./libs/*.whl"] } },
            ],
          },
        },
      },
    );
    expect(classifyChange(spec, path.join(root, "pyproject.toml"))).toBe("source");
    expect(classifyChange(spec, path.join(root, "libs", "a.whl"))).toBe("source");
  });

  test("editing a .gitignore that lists itself re-checks; one in a skipped folder doesn't", async () => {
    const { root, spec } = await specFor(
      {
        "nb.py": "# Databricks notebook source\nprint(1)\n",
        ".gitignore": ".gitignore\nbuild/\n",
        "sub/.gitignore": ".gitignore\n",
        "build/.gitignore": "*\n",
      },
      { jobs: { j: { name: "j", tasks: [{ task_key: "t", notebook_task: { notebook_path: "./nb.py" } }] } } },
    );
    expect(classifyChange(spec, path.join(root, ".gitignore"))).toBe("source");
    expect(classifyChange(spec, path.join(root, "sub", ".gitignore"))).toBe("source");
    expect(classifyChange(spec, path.join(root, "build", ".gitignore"))).toBeUndefined();
  });

  test("a pipeline glob folder outside the bundle gets a watcher, and its files re-check", async () => {
    const { top, spec } = await specFor(
      { "external/source.sql": "SELECT 1;\n" },
      { pipelines: { p: { name: "p", libraries: [{ glob: { include: "../external/**" } }] } } },
      "bundle",
    );
    const external = path.join(top, "external");
    expect(foldersOutsideRoot(spec)).toEqual([external]);
    expect(classifyChange(spec, path.join(external, "new.sql"))).toBe("source");
  });

  test("a glob folder inside the bundle needs no watcher of its own (control)", async () => {
    const { spec } = await specFor(
      { "main.py": "print(1)\n" },
      { jobs: { j: { name: "j", tasks: [pythonTask({ libraries: [{ whl: "./dist/*.whl" }] })] } } },
    );
    expect(foldersOutsideRoot(spec)).toEqual([]);
  });

  test("glob patterns match one folder level at a time", () => {
    const pattern = path.join(path.sep, "b", "dist", "*.whl");
    expect(matchesGlobPattern(pattern, path.join(path.sep, "b", "dist", "x.whl"))).toBe(true);
    expect(matchesGlobPattern(pattern, path.join(path.sep, "b", "dist", "x.txt"))).toBe(false);
    expect(matchesGlobPattern(pattern, path.join(path.sep, "b", "dist", "s", "x.whl"))).toBe(false);
    expect(matchesGlobPattern(path.join(path.sep, "b", "*", "x.whl"), path.join(path.sep, "b", "dist", "x.whl"))).toBe(true);
  });
});
