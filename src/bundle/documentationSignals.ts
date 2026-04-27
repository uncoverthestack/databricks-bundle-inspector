import type { Job, JobTask, ParsedBundleConfig } from "./graph/bundleGraph.js";

export type DocumentationSignalSource =
  | "native_description"
  | "native_comment"
  | "dbi_comment";

export interface DocumentationSignal {
  scope: "job" | "task";
  source: DocumentationSignalSource;
  text: string;
  jobKey: string;
  taskKey?: string;
  file?: string;
  line?: number;
  yamlPath: string;
}

interface PathStackEntry {
  indent: number;
  path: string;
}

interface PendingComment {
  text: string;
  line: number;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function cleanCommentText(text: string): string {
  return text.trim();
}

function getIndent(line: string): number {
  return line.length - line.trimStart().length;
}

function parentPath(stack: PathStackEntry[]): string {
  return stack.at(-1)?.path ?? "";
}

function childPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function extractDbiComment(line: string): string | undefined {
  const match = line.match(/#\s*dbi:\s?(.*)$/i);
  return match ? cleanCommentText(match[1] ?? "") : undefined;
}

function removeInlineComment(line: string): string {
  const index = line.search(/\s+#\s*dbi:/i);
  return index === -1 ? line : line.slice(0, index);
}

function extractMapKey(trimmedLine: string): string | undefined {
  if (trimmedLine.startsWith("- ")) return undefined;
  const match = trimmedLine.match(/^([^:#\s][^:#]*):(?:\s|$)/);
  return match?.[1] ? stripQuotes(match[1]) : undefined;
}

function extractTaskKey(trimmedLine: string): string | undefined {
  const match = trimmedLine.match(/^-\s*task_key:\s*([^#]+?)\s*$/);
  return match?.[1] ? stripQuotes(match[1]) : undefined;
}

function jobFromPath(path: string): string | undefined {
  return path.match(/^resources\.(?:jobs|job)\.([^.]+)(?:\.|$)/)?.[1];
}

function taskFromPath(
  path: string,
): { jobKey: string; taskKey: string } | undefined {
  const match = path.match(
    /^resources\.(?:jobs|job)\.([^.]+)\.tasks\.([^.]+)(?:\.|$)/,
  );
  return match?.[1] && match[2]
    ? { jobKey: match[1], taskKey: match[2] }
    : undefined;
}

function targetForLine(
  trimmedLine: string,
  pathBeforeLine: string,
): { scope: "job" | "task"; jobKey: string; taskKey?: string; yamlPath: string } | undefined {
  const taskKey = extractTaskKey(trimmedLine);
  if (taskKey) {
    const jobKey = jobFromPath(pathBeforeLine);
    if (!jobKey) return undefined;
    return {
      scope: "task",
      jobKey,
      taskKey,
      yamlPath: `resources.jobs.${jobKey}.tasks.${taskKey}`,
    };
  }

  const existingTask = taskFromPath(pathBeforeLine);
  if (existingTask) {
    return {
      scope: "task",
      jobKey: existingTask.jobKey,
      taskKey: existingTask.taskKey,
      yamlPath: `resources.jobs.${existingTask.jobKey}.tasks.${existingTask.taskKey}`,
    };
  }

  const key = extractMapKey(trimmedLine);
  if (key && /^resources\.(?:jobs|job)$/.test(pathBeforeLine)) {
    return {
      scope: "job",
      jobKey: key,
      yamlPath: `resources.jobs.${key}`,
    };
  }

  const jobKey = jobFromPath(pathBeforeLine);
  if (jobKey) {
    return {
      scope: "job",
      jobKey,
      yamlPath: `resources.jobs.${jobKey}`,
    };
  }

  return undefined;
}

function appendDbiSignals(
  signals: DocumentationSignal[],
  filePath: string,
  comments: PendingComment[],
  target:
    | {
        scope: "job" | "task";
        jobKey: string;
        taskKey?: string;
        yamlPath: string;
      }
    | undefined,
): void {
  if (comments.length === 0 || !target) return;
  const text = comments.map((comment) => comment.text).join("\n").trim();
  if (!text) return;
  signals.push({
    scope: target.scope,
    source: "dbi_comment",
    text,
    jobKey: target.jobKey,
    ...(target.taskKey ? { taskKey: target.taskKey } : {}),
    file: filePath,
    line: comments[0]?.line ?? 1,
    yamlPath: target.yamlPath,
  });
}

function updatePathStack(
  stack: PathStackEntry[],
  indent: number,
  trimmedLine: string,
): void {
  const taskKey = extractTaskKey(trimmedLine);
  if (taskKey) {
    const parent = parentPath(stack);
    stack.push({ indent, path: childPath(parent, taskKey) });
    return;
  }

  const key = extractMapKey(trimmedLine);
  if (!key) return;

  const parent = parentPath(stack);
  stack.push({ indent, path: childPath(parent, key) });
}

export function parseDbiCommentSignals(
  filePath: string,
  content: string,
): DocumentationSignal[] {
  const signals: DocumentationSignal[] = [];
  const stack: PathStackEntry[] = [];
  let pendingComments: PendingComment[] = [];

  content.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const fullLineComment = rawLine.match(/^\s*#\s*dbi:\s?(.*)$/i);
    if (fullLineComment) {
      pendingComments.push({
        text: cleanCommentText(fullLineComment[1] ?? ""),
        line: lineNumber,
      });
      return;
    }

    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      return;
    }

    const inlineComment = extractDbiComment(rawLine);
    const lineWithoutComment = removeInlineComment(rawLine);
    const indent = getIndent(lineWithoutComment);
    while (stack.length > 0 && indent <= stack.at(-1)!.indent) {
      stack.pop();
    }

    const trimmedLine = lineWithoutComment.trim();
    const currentTarget = targetForLine(trimmedLine, parentPath(stack));
    appendDbiSignals(signals, filePath, pendingComments, currentTarget);
    pendingComments = [];

    if (inlineComment !== undefined) {
      appendDbiSignals(
        signals,
        filePath,
        [{ text: inlineComment, line: lineNumber }],
        currentTarget,
      );
    }

    updatePathStack(stack, indent, trimmedLine);
  });

  return signals;
}

function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function taskKeyFor(task: JobTask, index: number): string {
  return task.task_key ?? `task-${index + 1}`;
}

function nativeSignal(
  source: "native_description" | "native_comment",
  text: string | undefined,
  jobKey: string,
  yamlPath: string,
  taskKey?: string,
): DocumentationSignal | undefined {
  if (!text) return undefined;
  return {
    scope: taskKey ? "task" : "job",
    source,
    text,
    jobKey,
    ...(taskKey ? { taskKey } : {}),
    yamlPath,
  };
}

export function collectNativeDocumentationSignals(
  parsedBundle: ParsedBundleConfig,
): DocumentationSignal[] {
  const signals: DocumentationSignal[] = [];
  const resources = parsedBundle.resources as
    | (ParsedBundleConfig["resources"] & { job?: Record<string, Job> })
    | undefined;
  const jobs =
    resources?.jobs ?? resources?.job ?? {};

  for (const [jobKey, jobValue] of Object.entries(jobs)) {
    const job = jobValue as Job;
    const jobDescription = nativeSignal(
      "native_description",
      textField(job.description),
      jobKey,
      `resources.jobs.${jobKey}.description`,
    );
    if (jobDescription) signals.push(jobDescription);

    const jobComment = nativeSignal(
      "native_comment",
      textField(job.comment),
      jobKey,
      `resources.jobs.${jobKey}.comment`,
    );
    if (jobComment) signals.push(jobComment);

    for (const [taskIndex, task] of (job.tasks ?? []).entries()) {
      const taskKey = taskKeyFor(task, taskIndex);
      const taskRecord = task as Record<string, unknown>;
      const taskDescription = nativeSignal(
        "native_description",
        textField(taskRecord.description),
        jobKey,
        `resources.jobs.${jobKey}.tasks.${taskKey}.description`,
        taskKey,
      );
      if (taskDescription) signals.push(taskDescription);

      const taskComment = nativeSignal(
        "native_comment",
        textField(taskRecord.comment),
        jobKey,
        `resources.jobs.${jobKey}.tasks.${taskKey}.comment`,
        taskKey,
      );
      if (taskComment) signals.push(taskComment);
    }
  }

  return signals;
}
