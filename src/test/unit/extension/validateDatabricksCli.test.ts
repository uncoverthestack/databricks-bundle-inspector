import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockRunVersionCommand = jest.fn<
  (
    candidate: string,
  ) => Promise<{
    stdout: string;
    stderr: string;
  }>
>();

jest.mock("../../../databricksCli/processRunner.js", () => ({
  runVersionCommand: mockRunVersionCommand,
}));

import {
  invalidateDatabricksCliCache,
  resolveDatabricksCli,
} from "../../../databricksCli/validateDatabricksCli.js";

describe("resolveDatabricksCli", () => {
  beforeEach(() => {
    invalidateDatabricksCliCache();
    mockRunVersionCommand.mockReset();
  });

  test("caches successful resolution per configured path", async () => {
    mockRunVersionCommand.mockResolvedValue({
      stdout: "Databricks CLI v0.295.0",
      stderr: "",
    });

    await resolveDatabricksCli("/opt/databricks-a");
    await resolveDatabricksCli("/opt/databricks-a");

    expect(mockRunVersionCommand).toHaveBeenCalledTimes(1);
    expect(mockRunVersionCommand).toHaveBeenCalledWith("/opt/databricks-a");
  });

  test("uses a separate cache entry for each configured path", async () => {
    mockRunVersionCommand.mockResolvedValue({
      stdout: "Databricks CLI v0.295.0",
      stderr: "",
    });

    await resolveDatabricksCli("/opt/databricks-a");
    await resolveDatabricksCli("/opt/databricks-b");

    expect(mockRunVersionCommand).toHaveBeenCalledTimes(2);
    expect(mockRunVersionCommand).toHaveBeenNthCalledWith(1, "/opt/databricks-a");
    expect(mockRunVersionCommand).toHaveBeenNthCalledWith(2, "/opt/databricks-b");
  });

  test("does not permanently cache failed auto-detection", async () => {
    mockRunVersionCommand
      .mockRejectedValueOnce(new Error("not installed"))
      .mockResolvedValueOnce({
        stdout: "Databricks CLI v0.295.0",
        stderr: "",
      });

    await expect(resolveDatabricksCli()).resolves.toBeUndefined();
    await expect(resolveDatabricksCli()).resolves.toMatchObject({
      ok: true,
      candidate: "databricks",
    });

    expect(mockRunVersionCommand).toHaveBeenCalledTimes(2);
  });
});
