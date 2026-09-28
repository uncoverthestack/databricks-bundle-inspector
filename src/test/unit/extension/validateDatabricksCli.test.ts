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
  databricksCliInstallUrl,
  databricksCliUpdateUrl,
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

    await expect(resolveDatabricksCli()).resolves.toEqual({ ok: false, problem: "not_installed" });
    await expect(resolveDatabricksCli()).resolves.toMatchObject({
      ok: true,
      candidate: "databricks",
    });

    expect(mockRunVersionCommand).toHaveBeenCalledTimes(2);
  });

  test("reports a bad cliPath setting before the PATH", async () => {
    mockRunVersionCommand.mockRejectedValue(new Error("spawn ENOENT"));

    await expect(resolveDatabricksCli("/opt/wrong/databricks")).resolves.toEqual({
      ok: false,
      problem: "configured_path_invalid",
      configuredPath: "/opt/wrong/databricks",
    });
  });

  test("still uses the PATH when the cliPath setting is bad", async () => {
    mockRunVersionCommand
      .mockRejectedValueOnce(new Error("spawn ENOENT"))
      .mockResolvedValueOnce({ stdout: "Databricks CLI v0.295.0", stderr: "" });

    await expect(resolveDatabricksCli("/opt/wrong/databricks")).resolves.toMatchObject({
      ok: true,
      candidate: "databricks",
    });
  });

  test("reports a databricks command that is not the Databricks CLI", async () => {
    mockRunVersionCommand.mockResolvedValue({ stdout: "Version: 0.18.0", stderr: "" });

    await expect(resolveDatabricksCli()).resolves.toEqual({
      ok: false,
      problem: "not_databricks_cli",
      versionOutput: "Version: 0.18.0",
    });
  });
});

describe("databricksCliInstallUrl", () => {
  test.each([
    ["darwin", "#homebrew-installation-for-macos"],
    ["win32", "#winget-installation-for-windows"],
    ["linux", "#curl-installation-for-linux-macos-and-windows"],
  ] as const)("opens the %s section", (platform, anchor) => {
    expect(databricksCliInstallUrl(platform)).toBe(
      `https://docs.databricks.com/aws/en/dev-tools/cli/install${anchor}`,
    );
  });

  test("falls back to the top of the page", () => {
    expect(databricksCliInstallUrl("freebsd")).toBe(
      "https://docs.databricks.com/aws/en/dev-tools/cli/install",
    );
  });
});

describe("databricksCliUpdateUrl", () => {
  test.each([
    ["darwin", "#homebrew-update-for-linux-or-macos"],
    ["win32", "#winget-update-for-windows"],
    ["linux", "#curl-update-for-linux-macos-and-windows"],
    ["freebsd", ""],
  ] as const)("opens the %s section", (platform, anchor) => {
    expect(databricksCliUpdateUrl(platform)).toBe(
      `https://docs.databricks.com/aws/en/dev-tools/cli/install${anchor}`,
    );
  });
});
