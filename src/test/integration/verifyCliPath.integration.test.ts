import { test, expect } from "@jest/globals";
import { verifyCliPath } from "../../databricksCli/validateDatabricksCli.js";

const runRealCliTests = process.env.RUN_REAL_DATABRICKS_CLI_TESTS === "1";

const maybeTest = runRealCliTests ? test : test.skip;

maybeTest(
  "verifyCliPath works with a real Databricks CLI installation",
  async () => {
    const result = await verifyCliPath("databricks");

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.versionOutput).toMatch(/^v\d+\.\d+\.\d+$/);
    }
  },
);
