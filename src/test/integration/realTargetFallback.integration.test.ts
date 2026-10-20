import { afterAll, describe, expect, test } from "@jest/globals";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateBundle } from "../../bundle/validateBundle.js";

const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
/** A ~/.databrickscfg profile: these cases need the CLI to get past its login step. */
const profile = process.env.INSPECTOR_TEST_PROFILE?.trim() || undefined;
const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function bundle(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dbi-target-fallback-"));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

const NOTEBOOK = "# Databricks notebook source\nprint(1)\n";

/**
 * The CLI stops at its first error and prints the bundle as far as it got. A real target is
 * shown when it got past login and nothing was left to merge; otherwise the graph falls back.
 * Each case ends in an error, so the CLI never reaches the step that creates a workspace folder.
 */
describe(`a real target the CLI stopped on (${cli})`, () => {
  (profile ? test : test.skip)("a bundle that uses Python is shown as the target, with the reason listed", async () => {
    const dir = await bundle({
      "databricks.yml": [
        "bundle: {name: dbi-fallback-python}",
        "python:",
        "  resources: ['resources:load_resources']",
        "targets:",
        "  dev:",
        "    default: true",
        "    resources:",
        "      jobs:",
        "        j: {name: dev-name}",
        "resources:",
        "  jobs:",
        "    j:",
        "      name: base-name",
        "      tasks:",
        "        - task_key: t",
        "          notebook_task: {notebook_path: ./src/nb.py}",
        "",
      ].join("\n"),
      "src/nb.py": NOTEBOOK,
    });

    const result = await validateBundle(dir, "dev", cli, profile);

    if (!result.ok) throw new Error(result.error.details ?? result.error.error);
    expect(result.data.resources?.jobs?.j?.name).toBe("dev-name");
    const messages = (result.issues ?? []).flatMap((issue) => issue.diagnostics ?? []).map((d) => d.message);
    expect(messages.join("\n")).toMatch(/Python/);
  });

  (profile ? test : test.skip)("a target whose task override was not merged yet falls back", async () => {
    // A required variable with no value stops the CLI after login but before it merges
    // the target's `load` into the base one, so the job has two tasks named `load`.
    const dir = await bundle({
      "databricks.yml": [
        "bundle: {name: dbi-fallback-unmerged}",
        "variables:",
        "  run_date: {description: required}",
        "targets:",
        "  dev:",
        "    default: true",
        "    resources:",
        "      jobs:",
        "        j:",
        "          tasks:",
        "            - task_key: load",
        "              notebook_task: {notebook_path: ./src/nb.py, base_parameters: {run_date: '${var.run_date}'}}",
        "resources:",
        "  jobs:",
        "    j:",
        "      tasks:",
        "        - task_key: load",
        "          notebook_task: {notebook_path: ./src/nb.py}",
        "",
      ].join("\n"),
      "src/nb.py": NOTEBOOK,
    });

    const result = await validateBundle(dir, "dev", cli, profile);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details).toMatch(/no value assigned to required variable run_date/);
  });

  (profile ? test : test.skip)("the same error with nothing to merge is shown as the target", async () => {
    const dir = await bundle({
      "databricks.yml": [
        "bundle: {name: dbi-fallback-merged}",
        "variables:",
        "  run_date: {description: required}",
        "targets:",
        "  dev: {default: true}",
        "resources:",
        "  jobs:",
        "    j:",
        "      tasks:",
        "        - task_key: load",
        "          notebook_task: {notebook_path: ./src/nb.py, base_parameters: {run_date: '${var.run_date}'}}",
        "",
      ].join("\n"),
      "src/nb.py": NOTEBOOK,
    });

    const result = await validateBundle(dir, "dev", cli, profile);

    if (!result.ok) throw new Error(result.error.details ?? result.error.error);
    const messages = (result.issues ?? []).flatMap((issue) => issue.diagnostics ?? []).map((d) => d.message);
    expect(messages.join("\n")).toMatch(/no value assigned to required variable run_date/);
  });
});
