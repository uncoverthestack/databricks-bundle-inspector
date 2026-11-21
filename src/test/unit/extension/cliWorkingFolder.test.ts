import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { realLookupEnvironment } from "../../../databricksCli/cliCandidates.js";
import { invalidateDatabricksCliCache, resolveDatabricksCli } from "../../../databricksCli/validateDatabricksCli.js";

const run = promisify(execFile);

// Real files and real processes: a fake `databricks` in a bundle folder, which the bundle's
// repo could hold, and the installed one in a PATH folder. Each only prints who it is (#459).
// Shell scripts, so not on Windows; the Windows rule is covered by the unit tests.
(process.platform === "win32" ? describe.skip : describe)("the CLI the checks find runs from any folder (#459)", () => {
  let dir: string;
  let bundle: string;
  let installed: string;

  const script = (file: string, says: string) => {
    writeFileSync(file, `#!/bin/sh\necho "${says}"\n`);
    chmodSync(file, 0o755);
  };
  const lookupWith = (pathValue: string, workspaceFolders: string[] = []) => ({
    ...realLookupEnvironment(),
    pathValue,
    extraCandidates: () => [],
    readRegistryPath: async () => undefined,
    workspaceFolders: () => workspaceFolders,
  });
  const says = async (file: string, pathValue: string) =>
    (await run(file, ["--version"], { cwd: bundle, env: { ...process.env, PATH: pathValue } })).stdout.trim();

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "bdi-cli-folder-"));
    bundle = path.join(dir, "bundle");
    installed = path.join(dir, "installed");
    mkdirSync(bundle);
    mkdirSync(installed);
    script(path.join(bundle, "databricks"), "Databricks CLI v9.9.9-from-the-bundle-folder");
    script(path.join(installed, "databricks"), "Databricks CLI v1.2.3-installed");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test.each([
    ["a . entry", (bin: string) => `.:${bin}`],
    ["an empty entry", (bin: string) => `:${bin}`],
  ])("with %s first on PATH, the installed CLI runs from the bundle folder", async (_label, makePath) => {
    const pathValue = makePath(installed);
    // Control: running it by name from the bundle folder, as before, starts the bundle's file.
    expect(await says("databricks", pathValue)).toBe("Databricks CLI v9.9.9-from-the-bundle-folder");

    invalidateDatabricksCliCache();
    const cli = await resolveDatabricksCli(undefined, lookupWith(pathValue));
    expect(cli).toMatchObject({ ok: true, candidate: path.join(installed, "databricks") });
    if (!cli.ok) return;
    expect(await says(cli.candidate, pathValue)).toBe("Databricks CLI v1.2.3-installed");
  });

  test("a PATH folder inside the open workspace is not used", async () => {
    invalidateDatabricksCliCache();
    const cli = await resolveDatabricksCli(undefined, lookupWith(`${bundle}:${installed}`, [dir + path.sep + "bundle"]));
    expect(cli).toMatchObject({ ok: true, candidate: path.join(installed, "databricks") });
  });
});
