import { describe, test, expect, beforeAll } from "@jest/globals";
import path from "node:path";
import ignore from "ignore";
import {
  extractBundleGraph,
  type ParsedBundleConfig,
} from "../../../bundle/graph/bundleGraph.js";
import {
  classifyChange,
  collectWatchSpec,
  filesOutsideRoot,
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

function at(rel: string): string {
  return path.join(bundleRoot, rel);
}

describe("collectWatchSpec", () => {
  test("watches the bundle files, task sources and pipeline folders the bundle points at", () => {
    expect(
      [...spec.files].map((file) => path.relative(bundleRoot, file)).sort(),
    ).toEqual([
      "databricks.yaml",
      "databricks.yml",
      "resources/jobs/yaml_edge_job.job.yml",
      "resources/pipelines/pipeline_from_nested_yaml.pipeline.yml",
      "src/tasks/generate_items.py",
      "src/tasks/missing_process_item.py",
    ]);
    expect(spec.folders.map((folder) => path.relative(bundleRoot, folder))).toEqual([
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
