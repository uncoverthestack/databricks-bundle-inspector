import { describe, expect, test } from "@jest/globals";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cliFilesOnPath,
  expandWindowsVariables,
  fileRunByName,
  moreCliCandidates,
  parseRegQueryPath,
  pathEntries,
  storedWindowsPath,
  WINDOWS_PATH_KEYS,
  type CliLookupEnvironment,
} from "../../../databricksCli/cliCandidates.js";

function machine(overrides: Partial<CliLookupEnvironment> & { files?: string[] } = {}): CliLookupEnvironment {
  const files = new Set(overrides.files ?? []);
  return {
    platform: "win32",
    pathValue: "",
    env: {},
    isFile: (file) => files.has(file),
    readRegistryPath: async () => undefined,
    extraCandidates: () => [],
    ...overrides,
  };
}

describe("pathEntries", () => {
  test("skips empty entries, a trailing separator and repeats", () => {
    expect(pathEntries("C:\\a;;C:\\b;C:\\a;", "win32")).toEqual(["C:\\a", "C:\\b"]);
  });

  test("treats Windows entries that differ only in letter case as one", () => {
    expect(pathEntries("C:\\Tools;c:\\tools", "win32")).toEqual(["C:\\Tools"]);
  });

  test("keeps macOS and Linux entries that differ in letter case apart", () => {
    expect(pathEntries("/opt/Tools:/opt/tools", "linux")).toEqual(["/opt/Tools", "/opt/tools"]);
  });

  test("removes quotes and spaces around an entry, keeping spaces and brackets inside", () => {
    expect(pathEntries(' "C:\\Program Files (x86)\\Tool" ;C:\\b', "win32")).toEqual([
      "C:\\Program Files (x86)\\Tool",
      "C:\\b",
    ]);
  });

  test("handles a missing PATH", () => {
    expect(pathEntries(undefined, "linux")).toEqual([]);
  });

  test("splits on : outside Windows, so C: is not split there", () => {
    expect(pathEntries("C:\\a;C:\\b", "win32")).toEqual(["C:\\a", "C:\\b"]);
    expect(pathEntries("/a:/b", "darwin")).toEqual(["/a", "/b"]);
  });
});

describe("cliFilesOnPath", () => {
  test("lists only folders that hold the CLI file, in PATH order", () => {
    const files = new Set(["/b/databricks", "/c/databricks"]);
    expect(cliFilesOnPath("/a:/b:/c", "linux", (f) => files.has(f))).toEqual(["/b/databricks", "/c/databricks"]);
  });

  test("looks for databricks.exe on Windows, never .cmd or .bat", () => {
    const seen: string[] = [];
    cliFilesOnPath("C:\\a", "win32", (f) => (seen.push(f), false));
    expect(seen).toEqual(["C:\\a\\databricks.exe"]);
  });
});

describe("parseRegQueryPath", () => {
  // Shapes checked with `reg query` on a real Windows machine.
  test("reads the system Path (REG_EXPAND_SZ)", () => {
    const output =
      "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n" +
      "    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;%SYSTEMROOT%\\System32\\Wbem;C:\\ProgramData\\chocolatey\\bin\r\n\r\n";
    expect(parseRegQueryPath(output)).toBe(
      "%SystemRoot%\\system32;%SYSTEMROOT%\\System32\\Wbem;C:\\ProgramData\\chocolatey\\bin",
    );
  });

  test("reads the user Path (REG_SZ)", () => {
    expect(parseRegQueryPath("\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_SZ    C:\\a;C:\\b;\r\n")).toBe(
      "C:\\a;C:\\b;",
    );
  });

  test("ignores other values and errors", () => {
    expect(parseRegQueryPath("    PATHEXT    REG_SZ    .COM;.EXE")).toBeUndefined();
    expect(parseRegQueryPath("ERROR: The system was unable to find the specified registry key or value.")).toBeUndefined();
    expect(parseRegQueryPath("")).toBeUndefined();
  });

  test("keeps spaces inside the value", () => {
    expect(parseRegQueryPath("    Path    REG_SZ    C:\\Program Files\\x;C:\\b")).toBe("C:\\Program Files\\x;C:\\b");
  });
});

describe("expandWindowsVariables", () => {
  test("fills in variables ignoring letter case", () => {
    expect(
      expandWindowsVariables("%SystemRoot%\\a;%SYSTEMROOT%\\b;%localappdata%\\c", {
        SystemRoot: "C:\\Windows",
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      }),
    ).toBe("C:\\Windows\\a;C:\\Windows\\b;C:\\Users\\me\\AppData\\Local\\c");
  });

  test("leaves unknown variables and lone percent signs as they are", () => {
    expect(expandWindowsVariables("%NOPE%\\a;C:\\100%;C:\\b", {})).toBe("%NOPE%\\a;C:\\100%;C:\\b");
  });

  test("does not join two entries through a percent sign in each", () => {
    expect(expandWindowsVariables("C:\\50%;%X%", { X: "C:\\x" })).toBe("C:\\50%;C:\\x");
  });
});

describe("storedWindowsPath", () => {
  test("reads the system Path, then the user Path", async () => {
    const read: string[] = [];
    const path = await storedWindowsPath(
      machine({
        env: { SystemRoot: "C:\\Windows" },
        readRegistryPath: async (key) => {
          read.push(key);
          return key === WINDOWS_PATH_KEYS[0]
            ? "    Path    REG_EXPAND_SZ    %SystemRoot%\\system32"
            : "    Path    REG_SZ    C:\\user";
        },
      }),
    );
    expect(read).toEqual(WINDOWS_PATH_KEYS);
    expect(path).toBe("C:\\Windows\\system32;C:\\user");
  });

  test("uses what it could read when one key fails", async () => {
    const path = await storedWindowsPath(
      machine({ readRegistryPath: async (key) => (key === "HKCU\\Environment" ? "    Path    REG_SZ    C:\\user" : undefined) }),
    );
    expect(path).toBe("C:\\user");
  });
});

describe("moreCliCandidates", () => {
  test("PATH first, then the stored Path, then other extensions, each once", async () => {
    const lookup = machine({
      pathValue: "C:\\a;C:\\shared",
      files: ["C:\\a\\databricks.exe", "C:\\shared\\databricks.exe", "C:\\stored\\databricks.exe", "C:\\ext\\databricks.exe"],
      readRegistryPath: async (key) => (key === "HKCU\\Environment" ? "    Path    REG_SZ    C:\\SHARED;C:\\stored" : undefined),
      extraCandidates: () => ["C:\\ext\\databricks.exe", "C:\\missing\\databricks.exe"],
    });
    expect(await moreCliCandidates(lookup)).toEqual([
      "C:\\a\\databricks.exe",
      "C:\\shared\\databricks.exe",
      "C:\\stored\\databricks.exe",
      "C:\\ext\\databricks.exe",
    ]);
  });

  test("skips stored entries that are files rather than folders", async () => {
    const lookup = machine({
      files: ["C:\\tool.exe"],
      readRegistryPath: async () => "    Path    REG_SZ    C:\\tool.exe",
    });
    expect(await moreCliCandidates(lookup)).toEqual([]);
  });
});

describe("fileRunByName", () => {
  test("skips a file the OS can't run, as running by name does", () => {
    const files = ["/first/databricks", "/second/databricks"];
    expect(fileRunByName(files, "darwin", (file) => file === "/second/databricks")).toBe("/second/databricks");
    expect(fileRunByName(files, "linux", () => true)).toBe("/first/databricks");
    expect(fileRunByName(files, "linux", () => false)).toBeUndefined();
  });

  test("on Windows, the first file runs: there is no execute permission", () => {
    expect(fileRunByName(["C:\\a\\databricks.exe", "C:\\b\\databricks.exe"], "win32", () => false)).toBe(
      "C:\\a\\databricks.exe",
    );
  });

  test("reads the real execute permission by default", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bundle-inspector-run-"));
    try {
      const plain = path.join(dir, "plain");
      const runnable = path.join(dir, "runnable");
      writeFileSync(plain, "");
      writeFileSync(runnable, "", { mode: 0o755 });
      chmodSync(plain, 0o644);
      expect(fileRunByName([plain, runnable], "linux")).toBe(runnable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
