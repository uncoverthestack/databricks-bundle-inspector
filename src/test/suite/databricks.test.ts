import * as assert from "assert";
import {
  extractVersion,
  getDatabricksCliVersion,
  DatabricksCliCommandError,
  DatabricksCliVersionParseError,
} from "../../utils/databricks";

suite("databricks CLI version", () => {
  test("extractVersion parses version without v prefix", () => {
    const result = extractVersion("Databricks CLI v0.292.0");
    assert.strictEqual(result, "0.292.0");
  });

  test("extractVersion parses version with v prefix", () => {
    const result = extractVersion("Databricks CLI v0.292.0");
    assert.strictEqual(result, "0.292.0");
  });

  test("extractVersion returns null when version is missing", () => {
    const result = extractVersion("databricks version unknown");
    assert.strictEqual(result, null);
  });

  test("getDatabricksCliVersion returns parsed version", async () => {
    const fakeRunner = async (_command: string): Promise<string> => {
      return "Databricks CLI v0.292.0";
    };

    const result = await getDatabricksCliVersion(fakeRunner);
    assert.strictEqual(result, "0.292.0");
  });

  test("getDatabricksCliVersion throws DatabricksCliVersionParseError when output cannot be parsed", async () => {
    const fakeRunner = async (_command: string): Promise<string> => {
      return "databricks version unknown";
    };

    await assert.rejects(
      () => getDatabricksCliVersion(fakeRunner),
      (error: unknown) => {
        assert.ok(error instanceof DatabricksCliVersionParseError);
        assert.match(
          (error as Error).message,
          /Unable to parse Databricks CLI version/,
        );
        return true;
      },
    );
  });

  test("getDatabricksCliVersion propagates DatabricksCliCommandError when command execution fails", async () => {
    const fakeRunner = async (_command: string): Promise<string> => {
      throw new DatabricksCliCommandError("Command not found");
    };

    await assert.rejects(
      () => getDatabricksCliVersion(fakeRunner),
      (error: unknown) => {
        assert.ok(error instanceof DatabricksCliCommandError);
        assert.match((error as Error).message, /Command not found/);
        return true;
      },
    );
  });
});
