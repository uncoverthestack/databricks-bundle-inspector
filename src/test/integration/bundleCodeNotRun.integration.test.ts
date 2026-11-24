import { afterAll, describe, expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RESTRICTED_EXECUTION_VARIABLE } from "../../databricksCli/restrictedExecution.js";
import { BUNDLE_PROBE_TARGET, validateBundle } from "../../bundle/validateBundle.js";
import { missingJobsReason } from "../../webview/lib/missingJobsReason.js";

const execFileAsync = promisify(execFile);
const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
const MARKER = "PREINIT_RAN.txt";
const created: string[] = [];

/** A bundle whose `preinit` script leaves a file behind when the CLI runs it. */
async function bundleWithTripwire(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dbi-tripwire-"));
  created.push(dir);
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "load.py"), "# Databricks notebook source\nprint(1)\n");
  await writeFile(
    path.join(dir, "databricks.yml"),
    [
      "bundle:",
      "  name: tripwire",
      "",
      "experimental:",
      "  scripts:",
      `    preinit: "echo ran > ${MARKER}"`,
      "",
      "resources:",
      "  jobs:",
      "    nightly:",
      "      name: nightly",
      "      tasks:",
      "        - task_key: load",
      "          notebook_task:",
      "            notebook_path: ./src/load.py",
      "",
    ].join("\n"),
  );
  return dir;
}

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * SECURITY.md promises the extension does not run code from a bundle. The Databricks
 * CLI runs a bundle's `experimental.scripts.preinit` during `bundle validate`, so that
 * promise holds only because the extension asks the CLI not to. This runs against every
 * CLI version in the matrix.
 */
describe(`a bundle's scripts are not run by the inspector (${cli})`, () => {
  test("the tripwire works: the CLI alone runs the script on validate", async () => {
    const dir = await bundleWithTripwire();
    const env = { ...process.env };
    delete env[RESTRICTED_EXECUTION_VARIABLE];

    await execFileAsync(cli, ["bundle", "validate", "--target", BUNDLE_PROBE_TARGET, "--output", "json"], {
      cwd: dir,
      env,
      timeout: 30_000,
    }).catch(() => undefined); // The made-up target makes the CLI exit non-zero.

    // If this ever fails, the CLI stopped running scripts on validate and the test below proves nothing.
    expect(existsSync(path.join(dir, MARKER))).toBe(true);
  });

  test("the inspector's validation does not run it, still reads the bundle, and says so", async () => {
    const dir = await bundleWithTripwire();

    const result = await validateBundle(dir, undefined, cli);

    expect(existsSync(path.join(dir, MARKER))).toBe(false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.data.resources?.jobs ?? {})).toEqual(["nightly"]);
    const diagnostics = (result.issues ?? []).flatMap((issue) => issue.diagnostics ?? []);
    expect(diagnostics).toEqual([
      {
        severity: "warning",
        message:
          "This bundle's scripts (experimental.scripts) were not run. The inspector never runs code from a bundle, so what it shows may differ from a deploy.",
        path: "databricks.yml",
        line: 5,
        column: 3,
      },
    ]);
  });
});

/** A bundle folder with the given databricks.yml lines, cleaned up after the run. */
async function bundleWith(lines: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dbi-missing-jobs-"));
  created.push(dir);
  await writeFile(path.join(dir, "databricks.yml"), [...lines, ""].join("\n"));
  return dir;
}

/**
 * Issue 549: the preview's empty panel says why jobs may be missing. That depends on the
 * CLI's preview output keeping the python section and each target's resources, though it
 * merges no target and never runs the Python.
 */
describe(`the preview's output says why jobs may be missing (${cli})`, () => {
  test("jobs defined in Python", async () => {
    const dir = await bundleWith([
      "bundle:",
      "  name: python_jobs",
      "python:",
      "  venv_path: .venv",
      "  resources:",
      '    - "resources:load_resources"',
      "targets:",
      "  dev:",
      "    default: true",
    ]);
    const result = await validateBundle(dir, undefined, cli);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.data.resources?.jobs ?? {})).toEqual([]);
    expect(missingJobsReason(result.data as never)).toBe(
      "Jobs defined in Python may be missing: the inspector doesn't run bundle code.",
    );
  });

  test("jobs set only inside targets", async () => {
    const job = (name: string) => [`          ${name}:`, `            name: ${name}`];
    const dir = await bundleWith([
      "bundle:",
      "  name: target_jobs",
      "targets:",
      "  dev:",
      "    default: true",
      "    resources:",
      "      jobs:",
      ...job("dev_job"),
      "  prod:",
      "    resources:",
      "      jobs:",
      ...job("prod_job"),
    ]);
    const result = await validateBundle(dir, undefined, cli);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.data.resources?.jobs ?? {})).toEqual([]);
    expect(missingJobsReason(result.data as never)).toBe(
      "Jobs set inside the dev and prod targets may be missing until you pick one.",
    );
  });
});
