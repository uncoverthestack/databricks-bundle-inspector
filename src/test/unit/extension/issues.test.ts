import { describe, expect, test } from "@jest/globals";
import path from "node:path";
import { buildInspectorIssues, issueBelongsToJob } from "../../../bundle/issues.js";
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

function jobNode(data: Record<string, unknown> = {}): BundleGraphNode {
  return {
    id: "resources.jobs.ingest",
    kind: "job",
    nodeType: "job",
    displayName: "ingest",
    data,
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

  test("warns when task file references use Git source without job git_source", () => {
    const graph: BundleGraph = {
      nodes: [
        jobNode(),
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

  test("does not warn when Git-sourced task files belong to a Git-sourced job", () => {
    const graph: BundleGraph = {
      nodes: [
        jobNode({
          git_source: {
            git_url: "https://github.com/acme/demo",
            git_provider: "gitHub",
            git_branch: "main",
          },
        }),
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
    ).toEqual([]);
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

  test("reports unrecognised task types as info, not a bundle problem", () => {
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
        severity: "info",
        kind: "unknown_task_type",
        title: "Task type not recognised by the inspector",
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

  test("carries the yaml path of resource-scoped validation diagnostics", () => {
    const graph: BundleGraph = { nodes: [], edges: [] };
    const validationIssues: ValidationIssue[] = [
      {
        code: "BUNDLE_DIAGNOSTICS",
        message: "Databricks CLI reported bundle diagnostics.",
        diagnostics: [
          {
            severity: "error",
            message: "invalid bundle",
            yamlPath: "resources.pipelines.p1",
            path: "resources/pipelines.yml",
            line: 6,
            column: 7,
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
        yamlPath: "resources.pipelines.p1",
        resourceId: "resources.pipelines.p1",
        file: path.resolve("/workspace/demo", "resources/pipelines.yml"),
        line: 6,
        column: 7,
      },
    ]);
  });

  test("does not turn Databricks auth failures into inspector issues", () => {
    const graph: BundleGraph = { nodes: [], edges: [] };
    const validationIssues: ValidationIssue[] = [
      {
        code: "AUTH_NOT_CONFIGURED",
        message: "Databricks authentication is not configured.",
        details:
          "failed during request visitor: default auth: cannot configure default credentials",
        diagnostics: [
          {
            severity: "warning",
            message:
              "failed during request visitor: default auth: cannot configure default credentials",
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
    ).toEqual([]);
  });
});

describe("pipeline issues and job scoping", () => {
  const pipelineNode: BundleGraphNode = {
    id: "resources.pipelines.bronze",
    kind: "pipeline",
    nodeType: "resource",
    displayName: "bronze",
    data: {},
    pipelineLibraries: [
      {
        kind: "notebook",
        path: "../src/dlt/missing.py",
        resolvedPath: "/workspace/demo/src/dlt/missing.py",
        exists: false,
        checked: true,
        sourceFile: "/workspace/demo/resources/pipelines.yml",
        sourceLine: 9,
        sourceColumn: 19,
        yamlPath: "libraries[0].notebook.path",
      },
      {
        kind: "glob",
        path: "../src/dlt/empty/**",
        resolvedPath: "/workspace/demo/src/dlt/empty",
        exists: false,
        checked: true,
        sourceFile: "/workspace/demo/resources/pipelines.yml",
        sourceLine: 11,
        sourceColumn: 22,
        yamlPath: "libraries[1].glob.include",
      },
      {
        kind: "notebook",
        path: "/Users/someone/bronze",
        resolvedPath: undefined,
        exists: false,
        checked: false,
        sourceFile: "/workspace/demo/resources/pipelines.yml",
        sourceLine: 13,
        yamlPath: "libraries[2].notebook.path",
      },
    ],
  };

  test("reports missing pipeline sources against the pipeline, not a task", () => {
    const issues = buildInspectorIssues(
      { nodes: [pipelineNode], edges: [] },
      { bundle: { name: "demo" } },
      [],
      "/workspace/demo",
    );

    expect(issues).toEqual([
      {
        id: "missing-pipeline-source:resources.pipelines.bronze:libraries[0].notebook.path",
        severity: "error",
        kind: "missing_file",
        title: "Missing pipeline source file",
        detail: "../src/dlt/missing.py",
        resourceId: "resources.pipelines.bronze",
        yamlPath: "resources.pipelines.bronze.libraries[0].notebook.path",
        fixHint: "Create the file or update the path in the pipeline's libraries.",
        file: "/workspace/demo/resources/pipelines.yml",
        line: 9,
        column: 19,
      },
      {
        id: "missing-pipeline-source:resources.pipelines.bronze:libraries[1].glob.include",
        severity: "error",
        kind: "missing_file",
        title: "Pipeline source folder has no files",
        detail: "../src/dlt/empty/**",
        resourceId: "resources.pipelines.bronze",
        yamlPath: "resources.pipelines.bronze.libraries[1].glob.include",
        fixHint:
          "Add the pipeline source files, or update the glob include path in the pipeline's libraries.",
        file: "/workspace/demo/resources/pipelines.yml",
        line: 11,
        column: 22,
      },
    ]);
  });

  test("ties CLI diagnostics to the resource their yaml path points into", () => {
    const issues = buildInspectorIssues(
      { nodes: [], edges: [] },
      { bundle: { name: "demo" } },
      [
        {
          code: "BUNDLE_DIAGNOSTICS",
          message: "Databricks CLI reported bundle diagnostics.",
          diagnostics: [
            { severity: "warning", message: "unknown field: a", yamlPath: "resources.pipelines.gold.trigger.cron" },
            { severity: "warning", message: "unknown field: b", yamlPath: "resources.jobs.ingest.tasks[0]" },
            { severity: "warning", message: "unknown field: c" },
          ],
        },
      ],
      "/workspace/demo",
    );

    expect(issues.map((issue) => [issue.detail, issue.resourceId])).toEqual([
      ["a", "resources.pipelines.gold"],
      ["b", "resources.jobs.ingest"],
      ["c", undefined],
    ]);
  });

  test("a job lists its own task and job issues and bundle-wide ones, not another resource's", () => {
    const taskIds = new Set(["resources.jobs.ingest.tasks.extract"]);
    const belongs = (issue: { taskId?: string; resourceId?: string }) =>
      issueBelongsToJob(issue, "resources.jobs.ingest", taskIds);

    expect(belongs({ taskId: "resources.jobs.ingest.tasks.extract" })).toBe(true);
    expect(belongs({ taskId: "resources.jobs.other.tasks.load" })).toBe(false);
    expect(belongs({ resourceId: "resources.jobs.ingest" })).toBe(true);
    expect(belongs({ resourceId: "resources.jobs.other" })).toBe(false);
    expect(belongs({ resourceId: "resources.pipelines.bronze" })).toBe(false);
    expect(belongs({})).toBe(true);
  });
});
