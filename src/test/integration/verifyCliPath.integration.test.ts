import { test, expect } from "@jest/globals";
import { verifyCliPath } from "../../databricksCli/validateDatabricksCli.js";

const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";

// Runs against every CLI version in the matrix, so a change in how the CLI prints its
// version (which the extension parses) fails here first.
test(`verifyCliPath recognises a real Databricks CLI (${cli})`, async () => {
  const result = await verifyCliPath(cli);

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.versionOutput).toMatch(/^v\d+\.\d+\.\d+$/);
  }
});
