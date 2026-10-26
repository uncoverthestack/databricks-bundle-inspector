import { describe, test, expect } from "@jest/globals";
import {
  bundleRow,
  bundlesMessage,
  bundleStatus,
  checkAgainst,
  cliCandidates,
  cliChoices,
  cliRow,
  profileRow,
  targetLine,
  type SidebarBundle,
} from "../../../extension/sidebar.js";
import { bundleSummary } from "../../../extension/statusBar.js";

function bundle(overrides: Partial<SidebarBundle> = {}): SidebarBundle {
  return {
    root: "/work/analytics",
    name: "analytics",
    displayPath: "work/analytics/databricks.yml",
    state: "checked",
    count: { problems: 2, notes: 0 },
    contents: { jobs: 3, tasks: 11, pipelines: 1, files: 4 },
    cliIssue: undefined,
    checking: false,
    targets: ["dev", "prod"],
    ...overrides,
  };
}

describe("bundleRow", () => {
  test("says what the status bar says, so the two always agree", () => {
    for (const state of [undefined, "pending", "checked", "failed", "cli_missing"] as const) {
      for (const count of [{ problems: 0, notes: 0 }, { problems: 3, notes: 1 }, { problems: 0, notes: 2 }]) {
        const row = bundleRow(bundle({ state, count }));
        expect(row.description).toBe(bundleSummary(state, count, undefined));
      }
    }
  });

  test("names the bundle by its folder and lists what the check covered in the tooltip", () => {
    const row = bundleRow(bundle());
    expect(row.label).toBe("analytics");
    expect(row.tooltip).toBe(
      [
        "work/analytics/databricks.yml",
        "2 problems.",
        "3 jobs, 11 tasks, 1 pipeline and 4 files.",
        "Problems come from the structural preview.",
      ].join("\n"),
    );
  });

  test("shows a check that is running", () => {
    const row = bundleRow(bundle({ checking: true }));
    expect(row.description).toBe("checking…");
    expect(row.status).toBe("checking");
    expect(row.tooltip).toContain("Checking now.");
  });
});

describe("bundleStatus", () => {
  test("picks one icon for every state", () => {
    expect(bundleStatus(bundle({ state: undefined }))).toBe("pending");
    expect(bundleStatus(bundle({ state: "pending" }))).toBe("pending");
    expect(bundleStatus(bundle({ state: "cli_missing" }))).toBe("cli_missing");
    expect(bundleStatus(bundle({ count: { problems: 1, notes: 0 } }))).toBe("problems");
    expect(bundleStatus(bundle({ count: { problems: 0, notes: 5 } }))).toBe("passed");
    expect(bundleStatus(bundle({ state: "failed", count: { problems: 0, notes: 0 } }))).toBe("failed");
    expect(bundleStatus(bundle({ state: "failed", count: { problems: 2, notes: 0 } }))).toBe("problems");
  });
});

describe("checkAgainst", () => {
  test("lists the structural preview next to the targets, in use when no target is picked", () => {
    const group = checkAgainst(bundle());
    expect(group.description).toBe("structural preview");
    expect(group.options).toEqual([
      { target: undefined, label: "Structural preview", description: "shared settings · in use", inUse: true },
      { target: "dev", label: "dev", description: "", inUse: false },
      { target: "prod", label: "prod", description: "", inUse: false },
    ]);
  });

  test("marks the target the graph shows", () => {
    const group = checkAgainst(bundle({ graphTarget: { target: "dev", fellBack: false } }));
    expect(group.description).toBe("dev");
    expect(group.options.filter((option) => option.inUse).map((option) => option.label)).toEqual(["dev"]);
    expect(group.options[0]!.description).toBe("shared settings");
  });

  test("a target that couldn't be checked leaves the structural preview in use, and says so", () => {
    const group = checkAgainst(bundle({ graphTarget: { target: "prod", fellBack: true } }));
    expect(group.description).toBe("structural preview · prod couldn't be checked");
    expect(group.options.filter((option) => option.inUse).map((option) => option.label)).toEqual([
      "Structural preview",
    ]);
  });

  test("lists targets by name, so they stay put when the CLI lists them in another order", () => {
    const labels = (targets: string[]) =>
      checkAgainst(bundle({ targets })).options.map((option) => option.label);
    expect(labels(["dev", "ambiguous", "prod"])).toEqual(["Structural preview", "ambiguous", "dev", "prod"]);
    expect(labels(["prod", "dev", "ambiguous"])).toEqual(labels(["dev", "ambiguous", "prod"]));
  });

  test("before a check, only the structural preview is listed", () => {
    expect(checkAgainst(bundle({ state: "pending", targets: [] })).options.map((option) => option.label)).toEqual([
      "Structural preview",
    ]);
  });

  test("says the counts always come from the structural preview", () => {
    expect(checkAgainst(bundle()).tooltip).toContain("always use the structural preview");
  });
});

describe("cliRow", () => {
  test("shows the version in use, where it is from, and its file", () => {
    const row = cliRow({ ok: true, path: "/opt/homebrew/bin/databricks", version: "v1.21.0", source: "path" });
    expect(row.description).toBe("v1.21.0 · on PATH");
    expect(row.tooltip).toContain("/opt/homebrew/bin/databricks");
    expect(row.warning).toBe(false);
    expect(cliRow({ ok: true, path: "/x/databricks", version: "v1.21.0", source: "setting" }).description).toBe(
      "v1.21.0 · cliPath setting",
    );
  });

  test("warns about a version older than the oldest tested one", () => {
    const row = cliRow({ ok: true, path: "/usr/local/bin/databricks", version: "v0.240.0", source: "databricksExtension" });
    expect(row.description).toBe("v0.240.0 · Databricks extension · older than v0.299.0");
    expect(row.warning).toBe(true);
  });

  test("says why no CLI can be used", () => {
    expect(cliRow({ ok: false, issue: { problem: "not_installed" } }).description).toBe("not found");
    expect(cliRow({ ok: false, issue: { problem: "configured_path_invalid" } }).description).toBe(
      "the cliPath setting doesn't point to it",
    );
    expect(cliRow({ ok: false, issue: { problem: "not_databricks_cli", versionOutput: "Version 0.18.0" } }).description).toBe(
      "found the legacy pip CLI (0.18.0)",
    );
    expect(cliRow({ ok: false, issue: { problem: "not_databricks_cli", versionOutput: "hello" } }).description).toBe(
      '"databricks" is another program',
    );
    expect(cliRow({ ok: false, issue: { problem: "not_installed" } }).warning).toBe(true);
  });

  test("says it is looking before the first lookup ends", () => {
    expect(cliRow(undefined).description).toBe("looking…");
  });
});

describe("profileRow", () => {
  test("shows the profile setting, or the CLI's own choice", () => {
    expect(profileRow("analytics-dev").description).toBe("analytics-dev");
    expect(profileRow(undefined).description).toBe("CLI default");
    expect(profileRow(undefined).tooltip).toContain("The structural preview needs no sign-in.");
  });
});

describe("bundlesMessage", () => {
  test("only when no bundle could be checked for want of a CLI", () => {
    const missing = bundle({ state: "cli_missing", cliIssue: { problem: "not_installed" } });
    expect(bundlesMessage([])).toBeUndefined();
    expect(bundlesMessage([bundle()])).toBeUndefined();
    expect(bundlesMessage([missing, bundle()])).toBeUndefined();
    expect(bundlesMessage([missing, missing])).toContain("couldn't find it");
    expect(bundlesMessage([bundle({ state: "cli_missing", cliIssue: { problem: "configured_path_invalid" } })])).toContain(
      "couldn't use the one it found",
    );
  });
});

describe("targetLine", () => {
  const yaml = [
    "bundle:",
    "  name: analytics",
    "",
    "targets:",
    "  # the default",
    "  dev:",
    "    default: true",
    "    workspace:",
    "      host: https://example.invalid",
    '  "prod":',
    "    mode: production",
    "  staging: {}",
    "resources:",
    "  jobs:",
    "    dev:",
  ].join("\n");

  test("finds a target under the top-level targets mapping", () => {
    expect(targetLine(yaml, "dev")).toBe(5);
    expect(targetLine(yaml, "prod")).toBe(9);
    expect(targetLine(yaml, "staging")).toBe(11);
  });

  test("ignores nested keys and keys outside targets", () => {
    expect(targetLine(yaml, "workspace")).toBeUndefined();
    expect(targetLine(yaml, "jobs")).toBeUndefined();
    expect(targetLine("resources:\n  jobs:\n    dev:\n", "dev")).toBeUndefined();
  });

  test("reads a quoted targets key, anchors, aliases and flow mappings", () => {
    expect(targetLine('bundle:\n  name: x\n"targets":\n  dev:\n    default: true\n', "dev")).toBe(3);
    expect(targetLine("targets: &all\n  dev: {}\n  prod: {}\n", "prod")).toBe(2);
    expect(targetLine("shared: &all\n  dev: {}\ntargets: *all\n", "dev")).toBe(1);
    expect(targetLine("targets: { dev: {}, prod: {} }\n", "prod")).toBe(0);
    expect(targetLine("targets:\n  dev: &base\n    mode: development\n  qa: *base\n", "qa")).toBe(3);
  });

  test("a repeated target counts where it last appears, as the CLI keeps the last one", () => {
    expect(targetLine("targets:\n  dev: {}\n  dev:\n    mode: development\n", "dev")).toBe(2);
  });

  test("reads Windows line endings and a missing targets mapping", () => {
    expect(targetLine(yaml.replace(/\n/g, "\r\n"), "prod")).toBe(9);
    expect(targetLine("bundle:\n  name: x\n", "dev")).toBeUndefined();
  });
});

describe("cliCandidates", () => {
  test("lists each place once, in the order the lookup tries them", () => {
    expect(
      cliCandidates({
        setting: "/custom/databricks",
        onPath: ["/opt/homebrew/bin/databricks", "/custom/databricks", "/usr/local/bin/databricks"],
        windowsPath: [],
        databricksExtension: ["/ext/bin/databricks"],
        ignoreCase: false,
      }),
    ).toEqual([
      { path: "/custom/databricks", source: "setting" },
      { path: "/opt/homebrew/bin/databricks", source: "path" },
      { path: "/usr/local/bin/databricks", source: "path" },
      { path: "/ext/bin/databricks", source: "databricksExtension" },
    ]);
  });

  test("on Windows, the same file in another letter case counts once", () => {
    const found = cliCandidates({
      setting: undefined,
      onPath: ["C:\\Tools\\databricks.exe"],
      windowsPath: ["c:\\tools\\DATABRICKS.EXE", "C:\\Other\\databricks.exe"],
      databricksExtension: [],
      ignoreCase: true,
    });
    expect(found.map((candidate) => candidate.source)).toEqual(["path", "windowsPath"]);
  });
});

describe("cliChoices", () => {
  test("only Databricks CLIs, the one in use first, with where each is from", () => {
    const choices = cliChoices(
      [
        { path: "/opt/homebrew/bin/databricks", source: "path", isDatabricksCli: true, version: "v1.22.0" },
        { path: "/usr/local/bin/databricks", source: "path", isDatabricksCli: false, version: undefined },
        { path: "/old/databricks", source: "setting", isDatabricksCli: true, version: "v0.240.0" },
        { path: "/ext/bin/databricks", source: "databricksExtension", isDatabricksCli: true, version: "v1.21.0" },
      ],
      "/ext/bin/databricks",
    );
    expect(choices).toEqual([
      { path: "/ext/bin/databricks", label: "v1.21.0", description: "Databricks extension · in use", inUse: true },
      { path: "/opt/homebrew/bin/databricks", label: "v1.22.0", description: "on PATH", inUse: false },
      { path: "/old/databricks", label: "v0.240.0", description: "cliPath setting · older than v0.299.0", inUse: false },
    ]);
  });
});
