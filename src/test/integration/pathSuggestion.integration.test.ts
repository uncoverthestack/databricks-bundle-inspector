import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { enrichGraphWithFileContent } from "../../bundle/graph/enrichGraph.js";
import { extractBundleGraph } from "../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues, type InspectorIssue } from "../../bundle/issues.js";
import { locateFix } from "../../bundle/quickFix.js";
import { validateBundle } from "../../bundle/validateBundle.js";

/**
 * "Did you mean" for a missing file, judged by the real CLI: every suggested path, once
 * written in, must pass `bundle validate -t dev`. A local fake workspace answers the
 * CLI's sign-in calls, so nothing reaches a real one (as in variablesCli.integration).
 */

const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
const NOTEBOOK = "# Databricks notebook source\nprint(1)\n";
let root: string;
let server: Server;
let host: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dbi-path-suggestion-"));
  server = createServer((request, response) => {
    const url = request.url?.split("?")[0] ?? "";
    const body = url.endsWith("/scim/v2/Me")
      ? { id: "1", userName: "tester@example.com", active: true }
      : url.endsWith("/workspace/get-status")
        ? { object_type: "DIRECTORY", path: "/fake" }
        : {};
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

async function bundle(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(root, name);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  return dir;
}

async function findings(dir: string): Promise<InspectorIssue[]> {
  const result = await validateBundle(dir, undefined, cli);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(result.data, dir));
  return buildInspectorIssues(graph, result.data, result.issues ?? [], dir).filter(
    (issue) => issue.kind === "missing_file" || issue.kind === "missing_pipeline_source",
  );
}

/** Writes each fix into its file, as the Quick Fix menu does. */
function applyFixes(issues: InspectorIssue[]): void {
  for (const issue of issues) {
    const lines = readFileSync(issue.file!, "utf8").split("\n");
    const line = lines[issue.line! - 1]!;
    const span = locateFix(line, issue.fix!.oldText, issue.column!);
    expect(span).toBeDefined();
    lines[issue.line! - 1] = line.slice(0, span!.start) + issue.fix!.newText + line.slice(span!.end);
    writeFileSync(issue.file!, lines.join("\n"));
  }
}

async function validateDev(dir: string): Promise<string> {
  const config = path.join(root, "empty.databrickscfg");
  writeFileSync(config, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABRICKS_HOST: host,
    DATABRICKS_TOKEN: "fake-token",
    DATABRICKS_CONFIG_FILE: config,
    DATABRICKS_BUNDLE_RESTRICTED_CODE_EXECUTION: "1",
  };
  delete env.DATABRICKS_CONFIG_PROFILE;
  return new Promise((resolve) =>
    execFile(cli, ["bundle", "validate", "-t", "dev"], { cwd: dir, env, timeout: 60_000 }, (_error, stdout, stderr) =>
      resolve(`${stderr}${stdout}`),
    ),
  );
}

const BUNDLE_FILE = [
  "bundle:",
  "  name: suggestions",
  "include:",
  "  - resources/*.yml",
  "targets:",
  "  dev:",
  "    default: true",
  "",
].join("\n");

describe(`"Did you mean" for a missing file (${cli})`, () => {
  test("each suggestion is written from the YAML file's folder, and the CLI accepts every one", async () => {
    const dir = await bundle("fixable", {
      "databricks.yml": BUNDLE_FILE,
      "src/train.py": NOTEBOOK,
      "scripts/run.py": "print(1)\n",
      "pipelines/hourly.py": "print(1)\n",
      "resources/job.yml": [
        "resources:",
        "  jobs:",
        "    nightly:",
        "      name: nightly",
        // Compute, so that `validate` passes once the paths are right.
        "      job_clusters:",
        "        - job_cluster_key: c",
        "          new_cluster: { spark_version: 15.4.x-scala2.12, node_type_id: i3.xlarge, num_workers: 1 }",
        "      tasks:",
        "        - task_key: train",
        "          job_cluster_key: c",
        "          notebook_task:",
        "            notebook_path: ../notebooks/train.py",
        "        - task_key: run",
        "          job_cluster_key: c",
        "          spark_python_task:",
        "            python_file: ./run.py",
        "  pipelines:",
        "    hourly:",
        "      name: hourly",
        "      libraries:",
        "        - file:",
        "            path: ../dlt/hourly.py",
        "",
      ].join("\n"),
    });
    expect(await validateDev(dir)).toMatch(/not found/);

    const issues = await findings(dir);
    expect(issues.map((issue) => [issue.detail, issue.fix?.newText])).toEqual([
      ['../notebooks/train.py. Did you mean "../src/train.py"?', "../src/train.py"],
      ['./run.py. Did you mean "../scripts/run.py"?', "../scripts/run.py"],
      ['../dlt/hourly.py. Did you mean "../pipelines/hourly.py"?', "../pipelines/hourly.py"],
    ]);
    expect(issues[0]!.fix!.opens).toBe(path.join(dir, "src", "train.py"));

    applyFixes(issues);
    expect(await validateDev(dir)).toMatch(/Validation OK!/);
    expect(await findings(dir)).toEqual([]);
  });

  test("no suggestion when the file is the wrong kind, there are two, it isn't uploaded, or the path is a workspace path", async () => {
    const dir = await bundle("unsuggested", {
      "databricks.yml": BUNDLE_FILE,
      ".gitignore": "ignored/\n",
      // A notebook task: the only train.py has no notebook header ("expected a notebook").
      "src/train.py": "print(1)\n",
      // A Python file task: the only run.py is a notebook ("expected a file").
      "src/run.py": NOTEBOOK,
      // Two load.py notebooks: either could be meant.
      "a/load.py": NOTEBOOK,
      "b/load.py": NOTEBOOK,
      // Left out of the upload by .gitignore.
      "ignored/clean.py": NOTEBOOK,
      // A path from "/" is a workspace path; the CLI never looks for it locally.
      "notebook.py": NOTEBOOK,
      "resources/job.yml": [
        "resources:",
        "  jobs:",
        "    nightly:",
        "      name: nightly",
        "      tasks:",
        "        - task_key: train",
        "          notebook_task:",
        "            notebook_path: ../notebooks/train.py",
        "        - task_key: run",
        "          spark_python_task:",
        "            python_file: ../scripts/run.py",
        "        - task_key: load",
        "          notebook_task:",
        "            notebook_path: ../notebooks/load.py",
        "        - task_key: clean",
        "          notebook_task:",
        "            notebook_path: ../notebooks/clean.py",
        "        - task_key: workspace",
        "          notebook_task:",
        "            notebook_path: /notebook.py",
        "",
      ].join("\n"),
    });
    const issues = await findings(dir);
    expect(issues.map((issue) => [issue.detail, issue.fix])).toEqual([
      ["../notebooks/train.py", undefined],
      ["../scripts/run.py", undefined],
      ["../notebooks/load.py", undefined],
      ["../notebooks/clean.py", undefined],
      // Reported as missing today, though the CLI accepts it (a separate issue); never "Did you mean".
      ["/notebook.py", undefined],
    ]);
  });
});
