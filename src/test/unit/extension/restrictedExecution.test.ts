import { afterAll, describe, expect, test } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RESTRICTED_EXECUTION_VARIABLE,
  explainCodeNotRun,
  restrictedCliEnv,
} from "../../../databricksCli/restrictedExecution.js";

const SCRIPTS_ERROR =
  "failed to execute script: running scripts is not allowed when DATABRICKS_BUNDLE_RESTRICTED_CODE_EXECUTION is set";
const PYTHON_ERROR =
  "Running Python code is not allowed when DATABRICKS_BUNDLE_RESTRICTED_CODE_EXECUTION is set";
const created: string[] = [];

async function bundleDir(fileName: string, text: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dbi-restricted-"));
  created.push(dir);
  await writeFile(path.join(dir, fileName), text);
  return dir;
}

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("restrictedCliEnv", () => {
  test("adds the flag and keeps the rest of the environment", () => {
    expect(restrictedCliEnv({ PATH: "/bin", DATABRICKS_CONFIG_PROFILE: "dev" })).toEqual({
      PATH: "/bin",
      DATABRICKS_CONFIG_PROFILE: "dev",
      [RESTRICTED_EXECUTION_VARIABLE]: "1",
    });
  });

  test("cannot be switched off from outside", () => {
    expect(restrictedCliEnv({ [RESTRICTED_EXECUTION_VARIABLE]: "" })[RESTRICTED_EXECUTION_VARIABLE]).toBe("1");
  });
});

describe("explainCodeNotRun", () => {
  test("turns the CLI's script error into a warning on the scripts line", async () => {
    const dir = await bundleDir(
      "databricks.yml",
      "bundle:\n  name: demo\n\nexperimental:\n  scripts:\n    preinit: ./setup.sh\n",
    );
    const [diagnostic] = await explainCodeNotRun([{ severity: "error", message: SCRIPTS_ERROR }], dir);

    expect(diagnostic).toEqual({
      severity: "warning",
      message: expect.stringContaining("scripts (experimental.scripts) were not run"),
      path: "databricks.yml",
      line: 5,
      column: 3,
    });
    expect(diagnostic?.message).not.toContain("DATABRICKS_BUNDLE");
  });

  test("does the same for Python, in a databricks.yaml", async () => {
    const dir = await bundleDir("databricks.yaml", "bundle:\n  name: demo\npython:\n  venv_path: .venv\n");
    const [diagnostic] = await explainCodeNotRun([{ severity: "error", message: PYTHON_ERROR }], dir);

    expect(diagnostic).toMatchObject({
      severity: "warning",
      message: expect.stringContaining("Python code (the python section) was not run"),
      path: "databricks.yaml",
      line: 3,
      column: 1,
    });
  });

  test("points at the first line when the bundle file does not hold the section", async () => {
    const dir = await bundleDir("databricks.yml", "bundle:\n  name: demo\ninclude:\n  - scripts.yml\n");
    const [diagnostic] = await explainCodeNotRun([{ severity: "error", message: SCRIPTS_ERROR }], dir);

    expect(diagnostic).toMatchObject({ path: "databricks.yml", line: 1, column: 1 });
  });

  test("leaves every other diagnostic exactly as it was", async () => {
    const dir = await bundleDir("databricks.yml", "bundle:\n  name: demo\n");
    const others = [
      { severity: "error" as const, message: "failed to execute script: exit status 1" },
      { severity: "warning" as const, message: "unknown field: foo", path: "databricks.yml", line: 2, column: 3 },
    ];

    expect(await explainCodeNotRun(others, dir)).toBe(others);
  });
});
