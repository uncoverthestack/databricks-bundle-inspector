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
import type { CliLookupEnvironment } from "../../../databricksCli/cliCandidates.js";

/** A machine with the given files and stored Windows `Path` values, and nothing else. */
function machine(overrides: Partial<CliLookupEnvironment> & { files?: string[] } = {}): CliLookupEnvironment {
  const files = new Set(overrides.files ?? []);
  return {
    platform: "darwin",
    pathValue: "",
    env: {},
    isFile: (file) => files.has(file),
    readRegistryPath: async () => undefined,
    extraCandidates: () => [],
    ...overrides,
  };
}

const NEW_CLI = { stdout: "Databricks CLI v0.299.0", stderr: "" };
const PIP_CLI = { stdout: "Version 0.18.0", stderr: "" };

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

    await resolveDatabricksCli("/opt/databricks-a", machine());
    await resolveDatabricksCli("/opt/databricks-a", machine());

    expect(mockRunVersionCommand).toHaveBeenCalledTimes(1);
    expect(mockRunVersionCommand).toHaveBeenCalledWith("/opt/databricks-a");
  });

  test("uses a separate cache entry for each configured path", async () => {
    mockRunVersionCommand.mockResolvedValue({
      stdout: "Databricks CLI v0.295.0",
      stderr: "",
    });

    await resolveDatabricksCli("/opt/databricks-a", machine());
    await resolveDatabricksCli("/opt/databricks-b", machine());

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

    await expect(resolveDatabricksCli(undefined, machine())).resolves.toEqual({ ok: false, problem: "not_installed" });
    await expect(resolveDatabricksCli(undefined, machine())).resolves.toMatchObject({
      ok: true,
      candidate: "databricks",
    });

    expect(mockRunVersionCommand).toHaveBeenCalledTimes(2);
  });

  test("reports a bad cliPath setting before the PATH", async () => {
    mockRunVersionCommand.mockRejectedValue(new Error("spawn ENOENT"));

    await expect(resolveDatabricksCli("/opt/wrong/databricks", machine())).resolves.toEqual({
      ok: false,
      problem: "configured_path_invalid",
      configuredPath: "/opt/wrong/databricks",
    });
  });

  test("still uses the PATH when the cliPath setting is bad", async () => {
    mockRunVersionCommand
      .mockRejectedValueOnce(new Error("spawn ENOENT"))
      .mockResolvedValueOnce({ stdout: "Databricks CLI v0.295.0", stderr: "" });

    await expect(resolveDatabricksCli("/opt/wrong/databricks", machine())).resolves.toMatchObject({
      ok: true,
      candidate: "databricks",
    });
  });

  test("reports a databricks command that is not the Databricks CLI", async () => {
    mockRunVersionCommand.mockResolvedValue({ stdout: "Version 0.18.0", stderr: "" });

    await expect(resolveDatabricksCli(undefined, machine())).resolves.toEqual({
      ok: false,
      problem: "not_databricks_cli",
      versionOutput: "Version 0.18.0",
    });
  });
});

describe("resolveDatabricksCli, when databricks on the PATH does not work", () => {
  beforeEach(() => {
    invalidateDatabricksCliCache();
    mockRunVersionCommand.mockReset();
  });

  /** Answers `--version` per candidate; anything not listed is not found. */
  function versions(byCandidate: Record<string, { stdout: string; stderr: string }>) {
    mockRunVersionCommand.mockImplementation(async (candidate) => {
      const answer = byCandidate[candidate];
      if (!answer) throw new Error(`spawn ${candidate} ENOENT`);
      return answer;
    });
  }

  test("uses a later databricks on the PATH when the first is the legacy pip CLI", async () => {
    versions({ databricks: PIP_CLI, "/usr/local/bin/databricks": PIP_CLI, "/opt/homebrew/bin/databricks": NEW_CLI });
    const lookup = machine({
      pathValue: "/usr/local/bin:/opt/homebrew/bin",
      files: ["/usr/local/bin/databricks", "/opt/homebrew/bin/databricks"],
    });

    await expect(resolveDatabricksCli(undefined, lookup)).resolves.toMatchObject({
      ok: true,
      candidate: "/opt/homebrew/bin/databricks",
    });
  });

  test("still reports the pip CLI when no other databricks works", async () => {
    versions({ databricks: PIP_CLI, "/usr/local/bin/databricks": PIP_CLI });
    const lookup = machine({ pathValue: "/usr/local/bin", files: ["/usr/local/bin/databricks"] });

    await expect(resolveDatabricksCli(undefined, lookup)).resolves.toEqual({
      ok: false,
      problem: "not_databricks_cli",
      versionOutput: "Version 0.18.0",
    });
  });

  test("finds a WinGet install on the Path Windows stored, without a restart", async () => {
    const winget =
      "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Databricks.DatabricksCLI_Microsoft.Winget.Source_8wekyb3d8bbwe";
    versions({ [`${winget}\\databricks.exe`]: NEW_CLI });
    const lookup = machine({
      platform: "win32",
      pathValue: "C:\\Windows\\System32",
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      files: [`${winget}\\databricks.exe`],
      readRegistryPath: async (key) =>
        key === "HKCU\\Environment"
          ? `\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_SZ    %LOCALAPPDATA%\\Microsoft\\WindowsApps;${winget.replace("C:\\Users\\me\\AppData\\Local", "%LocalAppData%")}\r\n\r\n`
          : undefined,
    });

    await expect(resolveDatabricksCli(undefined, lookup)).resolves.toMatchObject({
      ok: true,
      candidate: `${winget}\\databricks.exe`,
    });
  });

  test("does not read the Windows registry on other systems", async () => {
    versions({});
    const readRegistryPath = jest.fn(async () => undefined);
    await resolveDatabricksCli(undefined, machine({ platform: "linux", readRegistryPath }));
    expect(readRegistryPath).not.toHaveBeenCalled();
  });

  test("goes on when the registry cannot be read", async () => {
    versions({ "/ext/bin/databricks.exe": NEW_CLI });
    const lookup = machine({
      platform: "win32",
      files: ["/ext/bin/databricks.exe"],
      readRegistryPath: async () => undefined,
      extraCandidates: () => ["/ext/bin/databricks.exe"],
    });
    await expect(resolveDatabricksCli(undefined, lookup)).resolves.toMatchObject({ ok: true });
  });

  test("uses the CLI the Databricks extension ships", async () => {
    const shipped = "/Users/me/.vscode/extensions/databricks.databricks-2.10.0-darwin-arm64/bin/databricks";
    versions({ [shipped]: NEW_CLI });
    const lookup = machine({ files: [shipped], extraCandidates: () => [shipped] });

    await expect(resolveDatabricksCli(undefined, lookup)).resolves.toMatchObject({
      ok: true,
      candidate: shipped,
    });
  });

  test("skips a shipped CLI whose file is not there", async () => {
    versions({});
    const lookup = machine({ extraCandidates: () => ["/gone/bin/databricks"] });

    await expect(resolveDatabricksCli(undefined, lookup)).resolves.toEqual({ ok: false, problem: "not_installed" });
    expect(mockRunVersionCommand).toHaveBeenCalledTimes(1);
  });

  test("skips an old shipped CLI that does not answer like the Databricks CLI", async () => {
    versions({ "/ext/bin/databricks": { stdout: "something else", stderr: "" } });
    const lookup = machine({ files: ["/ext/bin/databricks"], extraCandidates: () => ["/ext/bin/databricks"] });

    await expect(resolveDatabricksCli(undefined, lookup)).resolves.toMatchObject({ ok: false });
  });

  test("still reports a bad cliPath setting first when nothing is found", async () => {
    versions({});
    await expect(
      resolveDatabricksCli("/opt/wrong/databricks", machine({ pathValue: "/a:/b", files: [] })),
    ).resolves.toEqual({ ok: false, problem: "configured_path_invalid", configuredPath: "/opt/wrong/databricks" });
  });

  test("does nothing extra when databricks on the PATH works", async () => {
    versions({ databricks: NEW_CLI });
    const readRegistryPath = jest.fn(async () => undefined);
    const extraCandidates = jest.fn(() => []);
    await resolveDatabricksCli(undefined, machine({ platform: "win32", readRegistryPath, extraCandidates }));

    expect(mockRunVersionCommand).toHaveBeenCalledTimes(1);
    expect(readRegistryPath).not.toHaveBeenCalled();
    expect(extraCandidates).not.toHaveBeenCalled();
  });

  test("a 200-entry PATH only runs the files that exist", async () => {
    versions({ "/dir150/databricks": NEW_CLI });
    const entries = Array.from({ length: 200 }, (_, i) => `/dir${i}`);
    const lookup = machine({ pathValue: entries.join(":"), files: ["/dir150/databricks"] });

    await expect(resolveDatabricksCli(undefined, lookup)).resolves.toMatchObject({
      ok: true,
      candidate: "/dir150/databricks",
    });
    expect(mockRunVersionCommand).toHaveBeenCalledTimes(2);
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
