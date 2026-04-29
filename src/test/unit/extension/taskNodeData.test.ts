import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTaskNodeData } from "../../../bundle/resources/task.js";

let bundleRoot: string;

beforeAll(async () => {
  bundleRoot = await mkdtemp(path.join(tmpdir(), "bdi-task-test-"));
  await writeFile(path.join(bundleRoot, "notebook.py"), "# notebook", "utf8");
  await writeFile(path.join(bundleRoot, "query.sql"), "SELECT 1", "utf8");
  await writeFile(path.join(bundleRoot, "git_notebook.py"), "# git", "utf8");
});

afterAll(async () => {
  await rm(bundleRoot, { recursive: true, force: true });
});

function rawJob(
  params: Array<{ name: string; default?: string }> = [],
): Record<string, unknown> {
  return { parameters: params };
}

// --- taskType detection ---

describe("buildTaskNodeData — taskType", () => {
  test("notebook_task → notebook", () => {
    const result = buildTaskNodeData(
      { notebook_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskType).toBe("notebook");
  });

  test("clean_rooms_notebook_task → notebook", () => {
    const result = buildTaskNodeData(
      { clean_rooms_notebook_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskType).toBe("notebook");
  });

  test("sql_task → sql", () => {
    const result = buildTaskNodeData(
      { sql_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskType).toBe("sql");
  });

  test("spark_python_task → spark_python", () => {
    const result = buildTaskNodeData(
      { spark_python_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskType).toBe("spark_python");
  });

  test("python_wheel_task → python_wheel", () => {
    const result = buildTaskNodeData(
      { python_wheel_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskType).toBe("python_wheel");
  });

  test("pipeline_task → pipeline", () => {
    const result = buildTaskNodeData(
      { pipeline_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskType).toBe("pipeline");
  });

  test("run_job_task → run_job", () => {
    const result = buildTaskNodeData(
      { run_job_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskType).toBe("run_job");
  });

  test("dbt_task → dbt", () => {
    const result = buildTaskNodeData(
      { dbt_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskType).toBe("dbt");
  });

  test("condition_task → condition", () => {
    const result = buildTaskNodeData(
      { condition_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskType).toBe("condition");
  });

  test("for_each_task → for_each", () => {
    const result = buildTaskNodeData(
      { for_each_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskType).toBe("for_each");
  });

  test("dashboard_task → dashboard", () => {
    const result = buildTaskNodeData(
      { dashboard_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskType).toBe("dashboard");
  });

  test("no recognised task type → unknown", () => {
    const result = buildTaskNodeData({}, rawJob(), "job-1", "t", bundleRoot);
    expect(result.taskType).toBe("unknown");
  });
});

describe("buildTaskNodeData — fileReferences", () => {
  test("notebook_task with existing local file → exists true", () => {
    const result = buildTaskNodeData(
      { notebook_task: { notebook_path: "notebook.py" } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.fileReferences).toHaveLength(1);
    expect(result.fileReferences[0]?.referenceType).toBe("notebook");
    expect(result.fileReferences[0]?.exists).toBe(true);
    expect(result.fileReferences[0]?.resolvedPath).toBe(
      path.join(bundleRoot, "notebook.py"),
    );
  });

  test("notebook_task source GIT resolves extensionless notebook paths locally", () => {
    const result = buildTaskNodeData(
      { notebook_task: { notebook_path: "git_notebook", source: "GIT" } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );

    expect(result.fileReferences[0]?.exists).toBe(true);
    expect(result.fileReferences[0]?.source).toBe("GIT");
    expect(result.fileReferences[0]?.resolvedPath).toBe(
      path.join(bundleRoot, "git_notebook.py"),
    );
  });

  test("notebook_task source GIT prefers an exact local path before extension probing", () => {
    const result = buildTaskNodeData(
      { notebook_task: { notebook_path: "notebook.py", source: "GIT" } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );

    expect(result.fileReferences[0]?.exists).toBe(true);
    expect(result.fileReferences[0]?.resolvedPath).toBe(
      path.join(bundleRoot, "notebook.py"),
    );
  });

  test("notebook_task source omitted requires exact local path", () => {
    const result = buildTaskNodeData(
      { notebook_task: { notebook_path: "git_notebook" } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );

    expect(result.fileReferences[0]?.exists).toBe(false);
    expect(result.fileReferences[0]?.source).toBeUndefined();
    expect(result.fileReferences[0]?.resolvedPath).toBe(
      path.join(bundleRoot, "git_notebook"),
    );
  });

  test("notebook_task source WORKSPACE requires exact local path", () => {
    const result = buildTaskNodeData(
      { notebook_task: { notebook_path: "git_notebook", source: "WORKSPACE" } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );

    expect(result.fileReferences[0]?.exists).toBe(false);
    expect(result.fileReferences[0]?.source).toBe("WORKSPACE");
    expect(result.fileReferences[0]?.resolvedPath).toBe(
      path.join(bundleRoot, "git_notebook"),
    );
  });

  test("notebook_task with missing local file → exists false", () => {
    const result = buildTaskNodeData(
      { notebook_task: { notebook_path: "missing.py" } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.fileReferences[0]?.exists).toBe(false);
    expect(result.fileReferences[0]?.resolvedPath).toBe(
      path.join(bundleRoot, "missing.py"),
    );
  });

  test("workspace path → resolvedPath undefined, exists false", () => {
    const result = buildTaskNodeData(
      { notebook_task: { notebook_path: "/Workspace/my/notebook" } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.fileReferences[0]?.resolvedPath).toBeUndefined();
    expect(result.fileReferences[0]?.exists).toBe(false);
  });

  test("template expression → resolvedPath undefined, exists false", () => {
    const result = buildTaskNodeData(
      { notebook_task: { notebook_path: "${var.notebook_path}" } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.fileReferences[0]?.resolvedPath).toBeUndefined();
    expect(result.fileReferences[0]?.exists).toBe(false);
  });

  test("spark_python_task python_file → python_script referenceType", () => {
    const result = buildTaskNodeData(
      { spark_python_task: { python_file: "notebook.py" } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.fileReferences).toHaveLength(1);
    expect(result.fileReferences[0]?.referenceType).toBe("python_script");
    expect(result.fileReferences[0]?.exists).toBe(true);
  });

  test("sql_task file.path → sql referenceType", () => {
    const result = buildTaskNodeData(
      { sql_task: { file: { path: "query.sql" } } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.fileReferences).toHaveLength(1);
    expect(result.fileReferences[0]?.referenceType).toBe("sql");
    expect(result.fileReferences[0]?.exists).toBe(true);
  });

  test("dbt_task project_directory → dbt_project referenceType", () => {
    const result = buildTaskNodeData(
      { dbt_task: { project_directory: "dbt_project" } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.fileReferences).toHaveLength(1);
    expect(result.fileReferences[0]?.referenceType).toBe("dbt_project");
    expect(result.fileReferences[0]?.path).toBe("dbt_project");
  });

  test.each([
    ["python_wheel_task", { python_wheel_task: { package_name: "my_pkg" } }],
    [
      "spark_jar_task",
      { spark_jar_task: { main_class_name: "com.acme.Main" } },
    ],
    ["pipeline_task", { pipeline_task: { pipeline_id: "pipeline_id" } }],
    ["run_job_task", { run_job_task: { job_id: "job_id" } }],
    [
      "condition_task",
      { condition_task: { op: "EQUAL_TO", left: "1", right: "1" } },
    ],
    ["for_each_task", { for_each_task: { inputs: "[]" } }],
    ["dashboard_task", { dashboard_task: { dashboard_id: "dashboard_id" } }],
    [
      "dbt_task without project_directory",
      { dbt_task: { commands: ["dbt run"] } },
    ],
  ])("%s without local path field → empty fileReferences", (_name, rawTask) => {
    const result = buildTaskNodeData(
      rawTask,
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.fileReferences).toHaveLength(0);
  });

  test("yamlPath includes taskKey", () => {
    const result = buildTaskNodeData(
      { notebook_task: { notebook_path: "notebook.py" } },
      rawJob(),
      "job-1",
      "my_task",
      bundleRoot,
    );
    expect(result.fileReferences[0]?.yamlPath).toBe(
      "tasks.my_task.notebook_task.notebook_path",
    );
  });
});

// --- variableReferences ---

describe("buildTaskNodeData — variableReferences", () => {
  test("finds ${var.xxx} in notebook path", () => {
    const result = buildTaskNodeData(
      { notebook_task: { notebook_path: "${var.nb_path}" } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    const varRef = result.variableReferences.find(
      (r) => r.variableName === "nb_path",
    );
    expect(varRef).toBeDefined();
    expect(varRef?.expression).toBe("${var.nb_path}");
  });

  test("finds multiple distinct variable refs across a task", () => {
    const result = buildTaskNodeData(
      {
        notebook_task: {
          notebook_path: "${var.nb_path}",
          base_parameters: { env: "${var.env}" },
        },
      },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    const names = result.variableReferences.map((r) => r.variableName);
    expect(names).toContain("nb_path");
    expect(names).toContain("env");
  });

  test("no variable expressions → empty variableReferences", () => {
    const result = buildTaskNodeData(
      { notebook_task: { notebook_path: "notebook.py" } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.variableReferences).toHaveLength(0);
  });
});

// --- resourceReferences ---

describe("buildTaskNodeData — resourceReferences", () => {
  test("finds ${resources.pipelines.my_pipeline.id}", () => {
    const result = buildTaskNodeData(
      {
        pipeline_task: { pipeline_id: "${resources.pipelines.my_pipeline.id}" },
      },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.resourceReferences).toHaveLength(1);
    expect(result.resourceReferences[0]?.resourceType).toBe("pipelines");
    expect(result.resourceReferences[0]?.resourceName).toBe("my_pipeline");
    expect(result.resourceReferences[0]?.field).toBe("id");
  });

  test("no resource expressions → empty resourceReferences", () => {
    const result = buildTaskNodeData(
      { notebook_task: { notebook_path: "notebook.py" } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.resourceReferences).toHaveLength(0);
  });
});

// --- libraryReferences ---

describe("buildTaskNodeData — libraryReferences", () => {
  test("pypi library → isLocal false, exists undefined", () => {
    const result = buildTaskNodeData(
      {
        notebook_task: {},
        libraries: [{ pypi: { package: "pandas==2.0.0" } }],
      },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.libraryReferences).toHaveLength(1);
    expect(result.libraryReferences[0]?.libraryType).toBe("pypi");
    expect(result.libraryReferences[0]?.identifier).toBe("pandas==2.0.0");
    expect(result.libraryReferences[0]?.isLocal).toBe(false);
    expect(result.libraryReferences[0]?.exists).toBeUndefined();
  });

  test("maven library → identifier is coordinates string", () => {
    const result = buildTaskNodeData(
      {
        notebook_task: {},
        libraries: [{ maven: { coordinates: "com.example:lib:1.0" } }],
      },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.libraryReferences[0]?.libraryType).toBe("maven");
    expect(result.libraryReferences[0]?.identifier).toBe("com.example:lib:1.0");
  });

  test("local whl that exists → isLocal true, exists true", async () => {
    const whlPath = path.join(bundleRoot, "my_pkg-1.0-py3-none-any.whl");
    await writeFile(whlPath, "", "utf8");

    const result = buildTaskNodeData(
      {
        notebook_task: {},
        libraries: [{ whl: "my_pkg-1.0-py3-none-any.whl" }],
      },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.libraryReferences[0]?.isLocal).toBe(true);
    expect(result.libraryReferences[0]?.exists).toBe(true);
    expect(result.libraryReferences[0]?.resolvedPath).toBe(whlPath);
  });

  test("local whl that does not exist → isLocal true, exists false", () => {
    const result = buildTaskNodeData(
      { notebook_task: {}, libraries: [{ whl: "missing.whl" }] },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.libraryReferences[0]?.isLocal).toBe(true);
    expect(result.libraryReferences[0]?.exists).toBe(false);
  });

  test("dbfs whl → isLocal false, exists undefined", () => {
    const result = buildTaskNodeData(
      {
        notebook_task: {},
        libraries: [{ whl: "dbfs:/FileStore/libs/pkg.whl" }],
      },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.libraryReferences[0]?.isLocal).toBe(false);
    expect(result.libraryReferences[0]?.exists).toBeUndefined();
  });

  test("no libraries field → empty libraryReferences", () => {
    const result = buildTaskNodeData(
      { notebook_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.libraryReferences).toHaveLength(0);
  });
});

// --- taskParameterReferences ---

describe("buildTaskNodeData — taskParameterReferences", () => {
  test("extracts base_parameters from notebook_task", () => {
    const result = buildTaskNodeData(
      {
        notebook_task: {
          notebook_path: "notebook.py",
          base_parameters: { env: "prod" },
        },
      },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskParameterReferences).toHaveLength(1);
    expect(result.taskParameterReferences[0]?.name).toBe("env");
    expect(result.taskParameterReferences[0]?.value).toBe("prod");
  });

  test("hard-coded value with no job default → confidence HIGH", () => {
    const result = buildTaskNodeData(
      { notebook_task: { base_parameters: { mode: "append" } } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskParameterReferences[0]?.confidence).toBe("HIGH");
    expect(result.taskParameterReferences[0]?.containsVariableRef).toBe(false);
  });

  test("value contains ${var.xxx} → confidence LOW, containsVariableRef true", () => {
    const result = buildTaskNodeData(
      { notebook_task: { base_parameters: { env: "${var.environment}" } } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskParameterReferences[0]?.confidence).toBe("LOW");
    expect(result.taskParameterReferences[0]?.containsVariableRef).toBe(true);
  });

  test("job has matching param default → confidence MEDIUM", () => {
    const result = buildTaskNodeData(
      { notebook_task: { base_parameters: { env: "prod" } } },
      rawJob([{ name: "env", default: "dev" }]),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskParameterReferences[0]?.confidence).toBe("MEDIUM");
    expect(result.taskParameterReferences[0]?.jobParameterDefault).toBe("dev");
  });

  test("{{job.parameters.xxx}} value → isOverriddenByJob true", () => {
    const result = buildTaskNodeData(
      { notebook_task: { base_parameters: { env: "{{job.parameters.env}}" } } },
      rawJob([{ name: "env", default: "dev" }]),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskParameterReferences[0]?.isOverriddenByJob).toBe(true);
    expect(result.taskParameterReferences[0]?.effectiveValue).toBe("dev");
  });

  test("no base_parameters → empty taskParameterReferences", () => {
    const result = buildTaskNodeData(
      { notebook_task: { notebook_path: "notebook.py" } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.taskParameterReferences).toHaveLength(0);
  });

  test("yamlPath includes taskKey and payload key", () => {
    const result = buildTaskNodeData(
      { notebook_task: { base_parameters: { env: "prod" } } },
      rawJob(),
      "job-1",
      "my_task",
      bundleRoot,
    );
    expect(result.taskParameterReferences[0]?.yamlPath).toBe(
      "tasks.my_task.notebook_task.base_parameters.env",
    );
  });
});

// --- jobParameterReferences ---

describe("buildTaskNodeData — jobParameterReferences", () => {
  test("extracts all job parameters", () => {
    const result = buildTaskNodeData(
      { notebook_task: {} },
      rawJob([
        { name: "env", default: "dev" },
        { name: "limit", default: "100" },
      ]),
      "job-1",
      "my_task",
      bundleRoot,
    );
    expect(result.jobParameterReferences).toHaveLength(2);
    expect(result.jobParameterReferences[0]?.name).toBe("env");
    expect(result.jobParameterReferences[0]?.default).toBe("dev");
    expect(result.jobParameterReferences[0]?.referencedByTasks).toEqual([
      "my_task",
    ]);
  });

  test("parameter with no default → hasRuntimeOnlyUsage true", () => {
    const result = buildTaskNodeData(
      { notebook_task: {} },
      rawJob([{ name: "run_id" }]),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.jobParameterReferences[0]?.hasRuntimeOnlyUsage).toBe(true);
  });

  test("parameter with default → hasRuntimeOnlyUsage false", () => {
    const result = buildTaskNodeData(
      { notebook_task: {} },
      rawJob([{ name: "env", default: "dev" }]),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.jobParameterReferences[0]?.hasRuntimeOnlyUsage).toBe(false);
  });

  test("no job parameters → empty jobParameterReferences", () => {
    const result = buildTaskNodeData(
      { notebook_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.jobParameterReferences).toHaveLength(0);
  });
});

// --- dependsOn / runIf ---

describe("buildTaskNodeData — dependsOn and runIf", () => {
  test("dependsOn extracted from depends_on task_key values", () => {
    const result = buildTaskNodeData(
      {
        notebook_task: {},
        depends_on: [{ task_key: "extract" }, { task_key: "transform" }],
      },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.dependsOn).toEqual(["extract", "transform"]);
  });

  test("no depends_on → empty dependsOn", () => {
    const result = buildTaskNodeData(
      { notebook_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.dependsOn).toHaveLength(0);
  });

  test("runIf extracted from run_if", () => {
    const result = buildTaskNodeData(
      { notebook_task: {}, run_if: "ALL_SUCCESS" },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.runIf).toBe("ALL_SUCCESS");
  });

  test("no run_if → runIf undefined", () => {
    const result = buildTaskNodeData(
      { notebook_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.runIf).toBeUndefined();
  });
});

// --- for_each nested task ---

describe("buildTaskNodeData — for_each nested task", () => {
  test("builds nestedTask from for_each_task.task", () => {
    const result = buildTaskNodeData(
      {
        for_each_task: {
          inputs: "{{tasks.generate.values}}",
          task: { notebook_task: { notebook_path: "notebook.py" } },
        },
      },
      rawJob(),
      "job-1",
      "outer",
      bundleRoot,
    );
    expect(result.nestedTask).toBeDefined();
    expect(result.nestedTask?.taskType).toBe("notebook");
    expect(result.nestedTask?.taskKey).toBe("outer.__nested__");
    expect(result.nestedTask?.parentJobId).toBe("job-1");
  });

  test("non-for_each task → nestedTask undefined", () => {
    const result = buildTaskNodeData(
      { notebook_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.nestedTask).toBeUndefined();
  });

  test("for_each_task without a task field → nestedTask undefined", () => {
    const result = buildTaskNodeData(
      { for_each_task: { inputs: "{{tasks.gen.values}}" } },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.nestedTask).toBeUndefined();
  });
});

// --- static metadata ---

describe("buildTaskNodeData — metadata fields", () => {
  test("taskKey and parentJobId are set correctly", () => {
    const result = buildTaskNodeData(
      { notebook_task: {} },
      rawJob(),
      "resources.jobs.ingest_job",
      "extract",
      bundleRoot,
    );
    expect(result.taskKey).toBe("extract");
    expect(result.parentJobId).toBe("resources.jobs.ingest_job");
  });

  test("sourceLine and sourceColumn are 0 (not available from CLI JSON)", () => {
    const result = buildTaskNodeData(
      { notebook_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.sourceLine).toBe(0);
    expect(result.sourceColumn).toBe(0);
  });

  test("dbiComment is undefined", () => {
    const result = buildTaskNodeData(
      { notebook_task: {} },
      rawJob(),
      "job-1",
      "t",
      bundleRoot,
    );
    expect(result.dbiComment).toBeUndefined();
  });
});
