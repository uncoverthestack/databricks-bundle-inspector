import { afterAll, describe, expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  BUNDLE_TMP_VARIABLE,
  RESTRICTED_EXECUTION_VARIABLE,
} from "../../databricksCli/restrictedExecution.js";
import { validateBundle } from "../../bundle/validateBundle.js";

const execFileAsync = promisify(execFile);
const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
/**
 * A `~/.databrickscfg` profile to run the real-target cases with a login. CI has none,
 * so there the real target fails before the CLI writes anything. Set it locally to check
 * the case the fix is for: `INSPECTOR_TEST_PROFILE=DEFAULT npm run test:semantic:cli`.
 */
const profile = process.env.INSPECTOR_TEST_PROFILE?.trim() || undefined;
const created: string[] = [];

async function bundle(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dbi-untouched-"));
  created.push(dir);
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "load.py"), "# Databricks notebook source\nprint(1)\n");
  await writeFile(
    path.join(dir, "databricks.yml"),
    [
      "bundle:",
      "  name: untouched",
      "",
      "targets:",
      "  dev:",
      "    default: true",
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

/** Every file and folder under `dir`, relative to it. */
async function contents(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map((entry) => entry.split(path.sep).join("/")).sort();
}

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * The README promises the inspector writes nothing into a bundle's folder. With a real
 * target and a login, `bundle validate` creates `.databricks/.gitignore` there unless
 * DATABRICKS_BUNDLE_TMP points elsewhere.
 */
describe(`the inspector writes nothing into the bundle folder (${cli})`, () => {
  (profile ? test : test.skip)(
    "the check works: the CLI alone, with a login, creates .databricks in the bundle",
    async () => {
      const dir = await bundle();
      const env: NodeJS.ProcessEnv = { ...process.env, [RESTRICTED_EXECUTION_VARIABLE]: "1" };
      delete env[BUNDLE_TMP_VARIABLE];

      await execFileAsync(
        cli,
        ["bundle", "validate", "--output", "json", "--target", "dev", "--profile", profile ?? ""],
        { cwd: dir, env, timeout: 30_000 },
      );

      // If this ever fails, the CLI stopped writing here and the tests below prove nothing.
      expect(existsSync(path.join(dir, ".databricks", ".gitignore"))).toBe(true);
    },
  );

  test("structural preview", async () => {
    const dir = await bundle();
    const before = await contents(dir);

    const result = await validateBundle(dir, undefined, cli);

    expect(result.ok).toBe(true);
    expect(await contents(dir)).toEqual(before);
  });

  test(`real target${profile ? " with a login" : " without a login"}`, async () => {
    const dir = await bundle();
    const before = await contents(dir);

    const result = await validateBundle(dir, "dev", cli, profile);

    // With a login the CLI must get all the way through, or this proves nothing.
    if (profile) expect(result.ok).toBe(true);
    expect(await contents(dir)).toEqual(before);
  });
});
