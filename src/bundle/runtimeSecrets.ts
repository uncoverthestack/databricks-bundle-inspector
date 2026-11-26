/**
 * Secrets whose scope isn't written in the code (issue 535): what each task's read resolves to.
 * Shared by the Uses row, the task details and the bundle overview, so all three join and
 * name them the same way.
 *
 * A notebook gets a parameter's value from, highest first: the values a run is started with,
 * then a job parameter of that name, then the task's own parameter. Job parameters are pushed
 * down to tasks with key-value parameters, and win over a task parameter with the same name
 * (https://docs.databricks.com/aws/en/jobs/job-parameters). A run can pass other values, so a
 * value from the bundle is only ever the default.
 */

/** A secret read whose scope isn't written in the code, as the graph keeps it on a file. */
export interface RuntimeSecretRead {
  line: number;
  key?: string;
  /** The notebook parameter the scope comes from, when the code shows it. */
  parameter?: string;
}

export interface TaskRuntimeSecret {
  taskId: string;
  /** The file that reads the secret. */
  file?: string;
  line: number;
  /** The notebook parameter the scope comes from. */
  parameter?: string;
  /** Set when that parameter is a job parameter: every task of the job gets the same value. */
  jobParameter?: string;
  /** The scope the parameter's value gives by default, when the bundle sets one. */
  scope?: string;
}

interface Node {
  id: string;
  nodeType?: string | undefined;
  data?: Record<string, unknown> | undefined;
  codeFacts?: { runtimeSecrets?: RuntimeSecretRead[] | undefined } | undefined;
  taskData?: {
    taskParameterReferences?: Array<{ name: string; value?: string | undefined }> | undefined;
    jobParameterReferences?: Array<{ name: string; default?: string | undefined }> | undefined;
  } | undefined;
}

interface Edge {
  source: string;
  target: string;
  kind: string;
}

export interface RuntimeSecretGraph {
  nodes: readonly Node[];
  edges: readonly Edge[];
}

/** A value still holding a reference: a variable the preview keeps as text, or a run-time value. */
const NOT_A_VALUE = /\$\{|\{\{/;

/**
 * The secret reads in a task's file whose scope isn't written in the code, each with the
 * parameter it comes from and the scope that parameter gives by default.
 *
 * @param resolve Turns an expression into its value for the shown target (identity if unknown).
 */
export function taskRuntimeSecrets(
  graph: RuntimeSecretGraph,
  taskId: string,
  resolve: (value: string) => string = (value) => value,
  nodeById: ReadonlyMap<string, Node> = new Map(graph.nodes.map((node) => [node.id, node])),
): TaskRuntimeSecret[] {
  const task = nodeById.get(taskId);
  const file = graph.edges
    .filter((edge) => edge.source === taskId && edge.kind === "references")
    .map((edge) => nodeById.get(edge.target))
    .find((node) => node?.nodeType === "file");
  const reads = file?.codeFacts?.runtimeSecrets;
  if (!task || !file || !reads?.length) return [];
  const path = typeof file.data?.resolvedPath === "string" ? file.data.resolvedPath : undefined;
  // Only a notebook task's parameters reach `dbutils.widgets`.
  const notebook = file.data?.referenceType === "notebook";
  const jobParams = new Map((task.taskData?.jobParameterReferences ?? []).map((ref) => [ref.name, ref]));
  const taskParams = new Map((task.taskData?.taskParameterReferences ?? []).map((ref) => [ref.name, ref]));

  return [...reads]
    .sort((a, b) => a.line - b.line)
    .map((read) => {
      const base: TaskRuntimeSecret = { taskId, ...(path ? { file: path } : {}), line: read.line };
      if (!read.parameter || !notebook) return base;
      const jobParam = jobParams.get(read.parameter);
      const raw = jobParam ? jobParam.default : taskParams.get(read.parameter)?.value;
      const value = raw === undefined ? undefined : resolve(raw).trim();
      return {
        ...base,
        parameter: read.parameter,
        ...(jobParam ? { jobParameter: read.parameter } : {}),
        ...(value && !NOT_A_VALUE.test(value) ? { scope: value } : {}),
      };
    });
}

/**
 * What a read is joined by: its scope when known, then the job parameter it comes from, else
 * nothing it shares with another task's read, since nobody knows if two unknowns are the same.
 */
export function runtimeSecretGroup(read: TaskRuntimeSecret): string {
  if (read.scope) return `scope:${read.scope}`;
  if (read.jobParameter) return `job-parameter:${read.jobParameter}`;
  return `task:${read.taskId}:${read.parameter ?? ""}`;
}

/** The marker's words: "Set at run time", or where its value comes from. */
export function runtimeSecretLabel(read: Pick<TaskRuntimeSecret, "parameter" | "jobParameter">): string {
  if (read.jobParameter) return `From job parameter ${read.jobParameter}`;
  if (read.parameter) return `From parameter ${read.parameter}`;
  return "Set at run time";
}
