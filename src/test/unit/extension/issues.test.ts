import { describe, expect, test } from "@jest/globals";
import path from "node:path";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import type {
  BundleGraph,
  BundleGraphNode,
  ParsedBundleConfig,
} from "../../../bundle/graph/bundleGraph.js";
import type { TaskNodeData } from "../../../bundle/resources/task.js";
import type { ValidationIssue } from "../../../bundle/validateBundle.js";

function taskData(overrides: Partial<TaskNodeData> = {}): TaskNodeData {
  return {
    taskKey: "extract",
    taskType: "notebook",
    parentJobId: "resources.jobs.ingest",
    sourceFile: "/workspace/demo/resources/job.yml",
    sourceLine: 1,
    sourceColumn: 1,
    fileReferences: [],
    variableReferences: [],
    libraryReferences: [],
    resourceReferences: [],
    jobParameterReferences: [],
    taskParameterReferences: [],
    dependsOn: [],
    runIf: undefined,
    dbiComment: undefined,
    nestedTask: undefined,
    ...overrides,
  };
}

function taskNode(overrides: Partial<TaskNodeData> = {}): BundleGraphNode {
  return {
    id: "resources.jobs.ingest.tasks.extract",
    kind: "notebook",
    nodeType: "task",
    displayName: "extract",
    data: {},
    taskData: taskData(overrides),
  };
}

describe("buildInspectorIssues", () => {
  test("reports missing local file references", () => {
    const graph: BundleGraph = {
      nodes: [
        taskNode({
          fileReferences: [
            {
              path: "../src/missing.py",
              resolvedPath: "/workspace/demo/src/missing.py",
              exists: false,
              source: undefined,
              isInGitignore: false,
              referenceType: "notebook",
              sourceFile: "/workspace/demo/resources/job.yml",
              sourceLine: 12,
              sourceColumn: 7,
              yamlPath: "resources.jobs.ingest.tasks.extract.notebook_task.notebook_path",
            },
          ],
        }),
      ],
      edges: [],
    };

    expect(
      buildInspectorIssues(graph, { bundle: { name: "demo" } }, [], "/workspace/demo"),
    ).toMatchObject([
      {
        severity: "error",
        kind: "missing_file",
        title: "Missing local file reference",
        detail: "../src/missing.py",
        taskName: "extract",
        file: "/workspace/demo/resources/job.yml",
        line: 12,
        column: 7,
      },
    ]);
  });

  test("warns when task file references use Git source", () => {
    const graph: BundleGraph = {
      nodes: [
        taskNode({
          fileReferences: [
            {
              path: "ingest/highlights",
              resolvedPath: "/workspace/demo/ingest/highlights.py",
              exists: true,
              source: "GIT",
              isInGitignore: false,
              referenceType: "notebook",
              sourceFile: "/workspace/demo/resources/job.yml",
              sourceLine: 14,
              sourceColumn: 11,
              yamlPath: "resources.jobs.ingest.tasks.extract.notebook_task.notebook_path",
            },
          ],
        }),
      ],
      edges: [],
    };

    expect(
      buildInspectorIssues(
        graph,
        { bundle: { name: "demo" } },
        [],
        "/workspace/demo",
      ),
    ).toMatchObject([
      {
        severity: "warning",
        kind: "git_source_not_recommended",
        title: "Git-sourced task path is not recommended for bundles",
        detail: "ingest/highlights",
        taskName: "extract",
        file: "/workspace/demo/resources/job.yml",
        line: 14,
        column: 11,
      },
    ]);
  });

  test("reports missing local libraries", () => {
    const graph: BundleGraph = {
      nodes: [
        taskNode({
          libraryReferences: [
            {
              libraryType: "whl",
              identifier: "../dist/missing.whl",
              isLocal: true,
              resolvedPath: "/workspace/demo/dist/missing.whl",
              exists: false,
              sourceLine: 18,
              sourceColumn: 9,
              yamlPath: "resources.jobs.ingest.tasks.extract.libraries.0.whl",
            },
          ],
        }),
      ],
      edges: [],
    };

    expect(
      buildInspectorIssues(graph, { bundle: { name: "demo" } }, [], "/workspace/demo"),
    ).toMatchObject([
      {
        severity: "error",
        kind: "missing_library",
        title: "Missing local library",
        detail: "../dist/missing.whl",
        taskName: "extract",
        file: "/workspace/demo/resources/job.yml",
        line: 18,
        column: 9,
      },
    ]);
  });

  test("reports unresolved variables while ignoring defined variables", () => {
    const graph: BundleGraph = {
      nodes: [
        taskNode({
          variableReferences: [
            {
              expression: "${var.defined}",
              variableName: "defined",
              resolvedValue: undefined,
              sourceFile: "/workspace/demo/resources/job.yml",
              sourceLine: 20,
              sourceColumn: 13,
              yamlPath: "resources.jobs.ingest.tasks.extract.existing_cluster_id",
            },
            {
              expression: "${var.missing}",
              variableName: "missing",
              resolvedValue: undefined,
              sourceFile: "/workspace/demo/resources/job.yml",
              sourceLine: 21,
              sourceColumn: 13,
              yamlPath: "resources.jobs.ingest.tasks.extract.warehouse_id",
            },
          ],
        }),
      ],
      edges: [],
    };

    expect(
      buildInspectorIssues(
        graph,
        { bundle: { name: "demo" }, variables: { defined: {} } },
        [],
        "/workspace/demo",
      ),
    ).toMatchObject([
      {
        severity: "error",
        kind: "unresolved_variable",
        title: "Unresolved variable",
        detail: "missing",
        taskName: "extract",
        file: "/workspace/demo/resources/job.yml",
        line: 21,
        column: 13,
      },
    ]);
  });

  test("reports unknown task types", () => {
    const graph: BundleGraph = {
      nodes: [
        taskNode({
          taskType: "unknown",
        }),
      ],
      edges: [],
    };

    expect(
      buildInspectorIssues(graph, { bundle: { name: "demo" } }, [], "/workspace/demo"),
    ).toMatchObject([
      {
        severity: "warning",
        kind: "unknown_task_type",
        title: "Unknown or deprecated task type",
        detail: "extract",
        taskName: "extract",
        yamlPath: "tasks.extract",
        file: "/workspace/demo/resources/job.yml",
      },
    ]);
  });

  test("normalizes unknown field CLI diagnostics without wrapper detail", () => {
    const graph: BundleGraph = { nodes: [], edges: [] };
    const parsedBundle: ParsedBundleConfig = { bundle: { name: "demo" } };
    const validationIssues: ValidationIssue[] = [
      {
        code: "BUNDLE_DIAGNOSTICS",
        message: "Databricks CLI reported bundle diagnostics.",
        diagnostics: [
          {
            severity: "warning",
            message: "unknown field: desription",
          },
        ],
      },
    ];

    expect(
      buildInspectorIssues(
        graph,
        parsedBundle,
        validationIssues,
        "/workspace/demo",
      ),
    ).toEqual([
      {
        id: "validation:0:0",
        severity: "warning",
        kind: "unknown_or_deprecated_field",
        title: "Unknown or deprecated field",
        detail: "desription",
        fixHint:
          "Remove the field or update it to a Databricks Bundle field supported by your CLI version.",
      },
    ]);
  });

  test("keeps validation diagnostic locations", () => {
    const graph: BundleGraph = { nodes: [], edges: [] };
    const validationIssues: ValidationIssue[] = [
      {
        code: "BUNDLE_DIAGNOSTICS",
        message: "Databricks CLI reported bundle diagnostics.",
        diagnostics: [
          {
            severity: "error",
            message: "invalid bundle",
            path: "databricks.yml",
            line: 4,
            column: 2,
          },
        ],
      },
    ];

    expect(
      buildInspectorIssues(
        graph,
        { bundle: { name: "demo" } },
        validationIssues,
        "/workspace/demo",
      ),
    ).toEqual([
      {
        id: "validation:0:0",
        severity: "error",
        kind: "validation_diagnostic",
        title: "invalid bundle",
        fixHint: "Review the Databricks CLI validation diagnostic.",
        file: path.resolve("/workspace/demo", "databricks.yml"),
        line: 4,
        column: 2,
      },
    ]);
  });
});
