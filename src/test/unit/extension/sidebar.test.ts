import { describe, test, expect } from "@jest/globals";
import {
  bundleRow,
  bundlesMessage,
  bundleStatus,
  cliCandidates,
  cliChoices,
  cliRow,
  compactContents,
  graphRow,
  graphRowOffersSignIn,
  pathHints,
  problemsRow,
  profileRow,
  targetLine,
  targetsRow,
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
  test("starts with what the status bar says, so the two always agree", () => {
    for (const state of [undefined, "pending", "checked", "failed", "cli_missing"] as const) {
      for (const count of [{ problems: 0, notes: 0 }, { problems: 3, notes: 1 }, { problems: 0, notes: 2 }]) {
        const row = bundleRow(bundle({ state, count }));
        expect(row.description.split(" · ")[0]).toBe(bundleSummary(state, count, undefined));
      }
    }
  });

  test("only the result: what the check covered is on the Graph row", () => {
    expect(bundleRow(bundle()).description).toBe("2 problems");
  });

  test("with where the bundle is, when another has the same name", () => {
    expect(bundleRow(bundle({ pathHint: "teams/sales/analytics" })).description).toBe(
      "2 problems · teams/sales/analytics",
    );
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
    expect(bundleRow(bundle({ checking: true, pathHint: "teams/sales/analytics" })).description).toBe(
      "checking… · teams/sales/analytics",
    );
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
    expect(bundleStatus(bundle({ count: { problems: 3, errors: 1, notes: 0 } }))).toBe("errors");
    expect(bundleStatus(bundle({ count: { problems: 0, notes: 5 } }))).toBe("passed");
    expect(bundleStatus(bundle({ state: "failed", count: { problems: 0, notes: 0 } }))).toBe("failed");
    expect(bundleStatus(bundle({ state: "failed", count: { problems: 2, notes: 0 } }))).toBe("problems");
  });
});

describe("compactContents", () => {
  test("jobs, tasks and pipelines; local files stay in the tooltip", () => {
    expect(compactContents({ jobs: 3, tasks: 11, pipelines: 0, files: 4 })).toBe("3 jobs · 11 tasks");
    expect(compactContents({ jobs: 1, tasks: 1, pipelines: 2, files: 0 })).toBe("1 job · 1 task · 2 pipelines");
    expect(compactContents({ jobs: 0, tasks: 0, pipelines: 0, files: 3 })).toBe("");
    expect(compactContents(undefined)).toBe("");
  });
});

describe("pathHints", () => {
  test("only bundles that share a folder name get their place", () => {
    const hints = pathHints([
      { root: "/w/teams/sales/analytics", name: "analytics", displayPath: "teams/sales/analytics/databricks.yml" },
      { root: "/w/teams/marketing/analytics", name: "analytics", displayPath: "teams/marketing/analytics/databricks.yml" },
      { root: "/w/ingest", name: "ingest", displayPath: "ingest/databricks.yml" },
    ]);
    expect([...hints]).toEqual([
      ["/w/teams/sales/analytics", "teams/sales/analytics"],
      ["/w/teams/marketing/analytics", "teams/marketing/analytics"],
    ]);
  });

  test("a bundle at the top of the folder, and Windows separators", () => {
    const hints = pathHints([
      { root: "/w", name: "w", displayPath: "databricks.yml" },
      { root: "/x/w", name: "w", displayPath: "x\\w\\databricks.yml" },
    ]);
    expect(hints.get("/w")).toBe("folder root");
    expect(hints.get("/x/w")).toBe("x/w");
  });
});

describe("graphRow", () => {
  test("on the structural preview, what the check covered; with a target picked, the target", () => {
    expect(graphRow(bundle()).description).toBe("3 jobs · 11 tasks · 1 pipeline");
    expect(graphRow(bundle()).tooltip).toContain("from the structural preview");
    expect(graphRow(bundle()).tooltip).toContain("Click to open the graph");
    expect(graphRow(bundle({ graphTarget: { target: "dev", fellBack: false } })).description).toBe("dev");
  });

  test("before a check, and after one that covered nothing", () => {
    expect(graphRow(bundle({ state: "pending", contents: undefined })).description).toBe("not checked yet");
    expect(graphRow(bundle({ state: "failed", contents: undefined })).description).toBe("");
  });

  test("a target that couldn't be checked says so", () => {
    const row = graphRow(bundle({ graphTarget: { target: "prod", fellBack: true } }));
    expect(row.description).toBe("prod couldn't be checked");
    expect(row.tooltip).toContain("the graph shows the structural preview");
  });

  test("a target waiting on a sign-in follows the graph's banner, and offers the key icon only while it does", () => {
    const at = (signIn: { stage: "needed" | "terminal" | "updated" | "checking"; blockedReason?: string }) =>
      bundle({ graphTarget: { target: "dev", fellBack: true, signIn } });
    expect(graphRow(at({ stage: "needed" })).description).toBe("dev needs sign-in");
    expect(graphRow(at({ stage: "needed" })).tooltip).toContain("typed, not run");
    expect(graphRow(at({ stage: "terminal" })).description).toBe("dev: press Enter in the terminal");
    expect(graphRow(at({ stage: "updated" })).description).toBe("sign-in profile updated");
    expect(graphRow(at({ stage: "checking" })).description).toBe("checking dev…");
    const blocked = at({ stage: "needed", blockedReason: "the \"tok\" profile signs in another way" });
    expect(graphRow(blocked).tooltip).toContain('Couldn\'t check dev: the "tok" profile signs in another way.');

    expect(graphRowOffersSignIn(at({ stage: "needed" }))).toBe(true);
    for (const signIn of [{ stage: "terminal" as const }, { stage: "updated" as const }, { stage: "checking" as const }]) {
      expect(graphRowOffersSignIn(at(signIn))).toBe(false);
    }
    expect(graphRowOffersSignIn(blocked)).toBe(false);
    expect(graphRowOffersSignIn(bundle({ graphTarget: { target: "dev", fellBack: true } }))).toBe(false);
  });
});

describe("problemsRow", () => {
  test("problems: the count with its scope, and a click opens the first", () => {
    const row = problemsRow(bundle());
    expect(row).toMatchObject({ description: "2 · structural preview", status: "problems", canOpen: true });
    expect(row.tooltip).toContain("Click to see all 2, by file, and pick one");
    expect(problemsRow(bundle({ count: { problems: 1, notes: 0 } })).tooltip).toContain("Click to open it where it is.");
  });

  test("none found says its scope rather than claiming the bundle passed", () => {
    const row = problemsRow(bundle({ count: { problems: 0, notes: 1 } }));
    expect(row).toMatchObject({ description: "none found · structural preview", status: "none", canOpen: false });
    expect(row.tooltip).toContain("A target can still have its own");
  });

  test("no result yet, or none possible, says what to do", () => {
    expect(problemsRow(bundle({ state: "pending" }))).toMatchObject({ description: "not checked yet", canOpen: false });
    expect(problemsRow(bundle({ state: undefined })).tooltip).toContain("Check Again");
    expect(problemsRow(bundle({ state: "cli_missing", count: { problems: 0, notes: 0 } })).tooltip).toContain("Settings");
    expect(problemsRow(bundle({ state: "failed", count: { problems: 0, notes: 0 } }))).toMatchObject({
      description: "not checked",
      status: "unknown",
    });
  });

  test("shows the most severe problem: one error is enough for the error icon", () => {
    expect(problemsRow(bundle({ count: { problems: 9, errors: 1, notes: 0 } })).status).toBe("errors");
    expect(problemsRow(bundle({ count: { problems: 9, errors: 0, notes: 0 } })).status).toBe("problems");
  });

  test("a failed check that still found problems lets them be opened", () => {
    expect(problemsRow(bundle({ state: "failed" })).canOpen).toBe(true);
  });
});

describe("targetsRow", () => {
  test("lists targets by name, so they stay put when the CLI lists them in another order", () => {
    const names = (targets: string[]) => targetsRow(bundle({ targets })).targets.map((item) => item.target);
    expect(names(["dev", "ambiguous", "prod"])).toEqual(["ambiguous", "dev", "prod"]);
    expect(names(["prod", "dev", "ambiguous"])).toEqual(names(["dev", "ambiguous", "prod"]));
    expect(targetsRow(bundle()).description).toBe("dev, prod");
  });

  test("marks the target the graph uses, not one that couldn't be checked", () => {
    expect(targetsRow(bundle({ graphTarget: { target: "dev", fellBack: false } })).targets).toEqual([
      { target: "dev", description: "graph in use" },
      { target: "prod", description: "" },
    ]);
    expect(
      targetsRow(bundle({ graphTarget: { target: "dev", fellBack: true } })).targets.every((item) => item.description === ""),
    ).toBe(true);
  });

  test("before a check, and with none", () => {
    expect(targetsRow(bundle({ state: "pending", targets: [] })).description).toBe("not checked yet");
    expect(targetsRow(bundle({ targets: [] })).description).toBe("none listed");
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

  // The CLI lists merged targets (`Available targets: prod, dev, staging`) on 0.299.0 and
  // 1.21.0; the row opens where the anchor writes each one.
  test("finds a target a `<<` merge brings in, where the anchor writes it", () => {
    const merged = "x-base: &base\n  dev:\n    default: true\n  staging: {}\ntargets:\n  <<: *base\n  prod: {}\n";
    expect(targetLine(merged, "dev")).toBe(1);
    expect(targetLine(merged, "staging")).toBe(3);
    expect(targetLine(merged, "prod")).toBe(6);
  });

  test("a target written directly beats a merged one, and a later merged anchor beats an earlier one", () => {
    const yaml = "a: &a\n  dev: {}\nb: &b\n  dev: {}\n  qa: {}\ntargets:\n  <<: [*a, *b]\n  qa: {}\n";
    expect(targetLine(yaml, "dev")).toBe(3);
    expect(targetLine(yaml, "qa")).toBe(7);
  });

  // The CLI names a key YAML reads as null as it is written (`Available targets: ~`, `null`, `Null`).
  test("finds targets named ~, null and Null", () => {
    expect(targetLine("targets:\n  ~: {}\n", "~")).toBe(1);
    expect(targetLine("targets:\n  dev: {}\n  null: {}\n", "null")).toBe(2);
    expect(targetLine("targets:\n  Null: {}\n", "Null")).toBe(1);
    expect(targetLine("targets:\n  ~: {}\n", "null")).toBeUndefined();
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
