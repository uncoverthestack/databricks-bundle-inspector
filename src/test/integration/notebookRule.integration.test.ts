import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { extractDatabricksVersion } from "../../databricksCli/parsing.js";
import { checkNotebookPath, notebookHeaderRuleFor } from "../../bundle/notebookFiles.js";

/**
 * Runs the CLI's own notebook check on every job task of the notebook-paths fixture and
 * fails when the inspector, using the rule it picks for this CLI version, disagrees. The
 * rule changed in v1.24.0; if a later release changes it again, CLI latest fails here.
 *
 * The CLI only checks paths against a real target, and CI has no login, so validate runs
 * against a small fake workspace on 127.0.0.1 that answers the calls it makes. Each task
 * gets a bundle of its own, because the CLI stops at the first path error.
 */

const execFileAsync = promisify(execFile);
const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
const fixtureRoot = path.resolve(__dirname, "../fixtures/notebook-paths");

type Verdict = "ok" | "missing_extension" | "not_a_notebook" | "is_a_notebook";

// The task fields that take a local path, and whether the CLI expects a notebook there.
const PATH_FIELDS: Array<{ payload: string; field: string[]; expects: "notebook" | "file" }> = [
  { payload: "notebook_task", field: ["notebook_path"], expects: "notebook" },
  { payload: "spark_python_task", field: ["python_file"], expects: "file" },
  { payload: "sql_task", field: ["file", "path"], expects: "file" },
];

/** What `bundle validate` said about the task's path. */
function cliVerdict(output: string): Verdict {
  if (/expected a notebook .* but got a file/.test(output)) return "not_a_notebook";
  if (/unable to determine if .* is a notebook/.test(output)) return "not_a_notebook";
  if (/expected a file .* but got a notebook/.test(output)) return "is_a_notebook";
  if (/notebook ".*" not found/.test(output)) return "missing_extension";
  return "ok";
}

let server: http.Server;
let host: string;
let workDir: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/2.0/preview/scim/v2/Me")) {
      res.end(JSON.stringify({ id: "1", userName: "tester@example.com" }));
    } else if (req.url?.startsWith("/api/2.0/workspace/get-status")) {
      res.end(JSON.stringify({ object_type: "DIRECTORY", path: "/" }));
    } else {
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  workDir = mkdtempSync(path.join(os.tmpdir(), "dbi-notebook-rule-"));
  writeFileSync(path.join(workDir, "empty.cfg"), "");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
});

/** Every job task with a local path, from the fixture's job file. */
function fixtureTasks(): Array<{ key: string; task: Record<string, unknown>; rawPath: string; expects: "notebook" | "file" }> {
  const parsed = parse(readFileSync(path.join(fixtureRoot, "resources/notebook_paths.job.yml"), "utf8")) as {
    resources: { jobs: Record<string, { tasks: Array<Record<string, unknown>> }> };
  };
  return Object.values(parsed.resources.jobs).flatMap((job) =>
    job.tasks.flatMap((task) => {
      for (const { payload, field, expects } of PATH_FIELDS) {
        let value: unknown = task[payload];
        for (const part of field) value = (value as Record<string, unknown> | undefined)?.[part];
        if (typeof value === "string") return [{ key: String(task.task_key), task, rawPath: value, expects }];
      }
      return [];
    }),
  );
}

async function validateOne(key: string, task: Record<string, unknown>): Promise<string> {
  // The fixture's paths are written from resources/ (`../src/...`), so the job file goes there.
  const dir = path.join(workDir, key);
  cpSync(path.join(fixtureRoot, "src"), path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, "resources"));
  writeFileSync(
    path.join(dir, "databricks.yml"),
    [
      "bundle:",
      "  name: notebook_rule",
      "include:",
      "  - resources/*.yml",
      "targets:",
      "  dev:",
      "    default: true",
      "    workspace:",
      `      host: ${host}`,
      "",
    ].join("\n"),
  );
  // An existing cluster, so a file task's missing compute is not the first error.
  const job = { name: "notebook_rule", tasks: [{ ...task, existing_cluster_id: "0000-000000-abcdefgh" }] };
  writeFileSync(
    path.join(dir, "resources", "job.yml"),
    JSON.stringify({ resources: { jobs: { notebook_rule: job } } }),
  );
  // No real login: an empty config file, a made-up token, and no DATABRICKS_* from the shell.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("DATABRICKS_")));
  try {
    const { stdout, stderr } = await execFileAsync(cli, ["bundle", "validate"], {
      cwd: dir,
      timeout: 60_000,
      env: { ...env, DATABRICKS_CONFIG_FILE: path.join(workDir, "empty.cfg"), DATABRICKS_TOKEN: "not-a-real-token" },
    });
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`;
  }
}

describe(`notebook header rule matches the CLI (${cli})`, () => {
  test("every fixture job task gets the CLI's verdict", async () => {
    const { stdout } = await execFileAsync(cli, ["--version"], { timeout: 30_000 });
    const version = extractDatabricksVersion(stdout);
    const rule = notebookHeaderRuleFor(version);

    const tasks = fixtureTasks();
    expect(tasks.length).toBeGreaterThan(10);
    const rows: Array<[string, Verdict, Verdict]> = [];
    for (const { key, task, rawPath, expects } of tasks) {
      const output = await validateOne(key, task);
      // The fake workspace must have got the CLI as far as its path checks.
      expect(output).not.toMatch(/Error: (Get|Post) "|connection refused|cannot configure default credentials/i);
      const resolved = path.resolve(fixtureRoot, "resources", rawPath);
      const inspector = checkNotebookPath(rawPath, resolved, expects, rule)?.kind ?? "ok";
      rows.push([key, cliVerdict(output), inspector]);
    }
    // One row per task: [task, CLI, inspector]. A mismatch shows which file and which way.
    expect(rows.filter(([, fromCli, fromInspector]) => fromCli !== fromInspector)).toEqual([]);
  }, 600_000);
});
