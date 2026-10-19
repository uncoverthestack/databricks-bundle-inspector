import { describe, test, expect } from "@jest/globals";
import {
  bundleContents,
  bundleForFile,
  bundleSummary,
  checkingView,
  checkStateOf,
  describeContents,
  orderForPicking,
  statusBarView,
  TOOLTIP_BUNDLE_LIMIT,
  type BundleCheckState,
  type BundleCount,
  type BundleStatus,
} from "../../../extension/statusBar.js";

describe("checkStateOf", () => {
  test("tells a missing CLI from other failures", () => {
    expect(checkStateOf({ ok: true })).toBe("checked");
    expect(checkStateOf({ ok: false, error: { errorCode: "CLI_NOT_FOUND" } })).toBe("cli_missing");
    expect(checkStateOf({ ok: false, error: { errorCode: "CLI_NOT_EXECUTABLE" } })).toBe("cli_missing");
    expect(checkStateOf({ ok: false, error: { errorCode: "VALIDATION_TIMEOUT" } })).toBe("failed");
    expect(checkStateOf({ ok: false, error: {} })).toBe("failed");
  });
});

describe("bundleSummary", () => {
  const none = { problems: 0, notes: 0 };

  test("covers every state in a few words", () => {
    expect(bundleSummary(undefined, none)).toBe("not checked yet");
    expect(bundleSummary("pending", none)).toBe("not checked yet");
    expect(bundleSummary("cli_missing", none)).toBe("Databricks CLI not found");
    expect(bundleSummary("checked", none)).toBe("no problems");
    expect(bundleSummary("checked", { problems: 1, notes: 9 })).toBe("1 problem");
    expect(bundleSummary("checked", { problems: 4, notes: 0 })).toBe("4 problems");
    expect(bundleSummary("checked", { problems: 0, notes: 1 })).toBe("1 note");
    expect(bundleSummary("checked", { problems: 0, notes: 67 })).toBe("67 notes");
    expect(bundleSummary("failed", none)).toBe("not checked");
  });

  test("shows the errors of a check that failed but still reported some", () => {
    expect(bundleSummary("failed", { problems: 1, notes: 0 })).toBe("1 problem");
  });
});

const none = { problems: 0, notes: 0 };
const sales = { jobs: 3, tasks: 12, pipelines: 1, files: 8 };

/** The item for a folder with this one bundle. */
function one(
  state: BundleCheckState | undefined,
  count: BundleCount,
  extra: Partial<BundleStatus> = {},
) {
  return statusBarView([{ name: "orders_etl", state, count, ...extra }]);
}

describe("statusBarView, one bundle", () => {
  test("is hidden when the folder has no bundle", () => {
    expect(statusBarView([])).toBeUndefined();
  });

  test("says what was checked when it found nothing", () => {
    const view = one("checked", none, { contents: sales });
    expect(view).toMatchObject({ text: "$(pass) Bundle: no problems · 12 tasks", warning: false });
    expect(view?.tooltip).toBe("Checked 3 jobs, 12 tasks, 1 pipeline and 8 files.");
  });

  test("names pipelines when a bundle has no tasks, and nothing when it has neither", () => {
    expect(one("checked", none, { contents: { jobs: 0, tasks: 0, pipelines: 1, files: 0 } })?.text).toBe(
      "$(pass) Bundle: no problems · 1 pipeline",
    );
    const empty = one("checked", none, { contents: { jobs: 0, tasks: 0, pipelines: 0, files: 0 } });
    expect(empty?.text).toBe("$(pass) Bundle: no problems");
    expect(empty?.tooltip).toBe('Checked "orders_etl".');
  });

  test("still says no problems when the contents are unknown", () => {
    expect(one("checked", none)?.text).toBe("$(pass) Bundle: no problems");
  });

  test("puts the result before the contents, as VS Code cuts long text from the end", () => {
    expect(one("checked", none, { contents: sales })?.text.indexOf("no problems")).toBeLessThan(
      one("checked", none, { contents: sales })!.text.indexOf("12 tasks"),
    );
  });

  test("counts the problems, with the right singular, and leaves the contents to the tooltip", () => {
    expect(one("checked", { problems: 1, notes: 0 }, { contents: sales })?.text).toBe("$(warning) Bundle: 1 problem");
    const view = one("checked", { problems: 3, notes: 0 }, { contents: sales });
    expect(view?.text).toBe("$(warning) Bundle: 3 problems");
    expect(view?.tooltip).toBe("Checked 3 jobs, 12 tasks, 1 pipeline and 8 files.");
  });

  test("does not say 'no problems' when there are only notes", () => {
    const view = one("checked", { problems: 0, notes: 67 }, { contents: sales });
    expect(view?.text).toBe("$(info) Bundle: 67 notes · 12 tasks");
    expect(one("checked", { problems: 0, notes: 1 })?.text).toBe("$(info) Bundle: 1 note");
  });

  test("leads with the problems when there are notes too", () => {
    expect(one("checked", { problems: 2, notes: 5 })?.text).toBe("$(warning) Bundle: 2 problems");
  });

  test("shows the errors of a check that failed", () => {
    expect(one("failed", { problems: 1, notes: 0 })?.text).toBe("$(warning) Bundle: 1 problem");
  });

  test("says the bundle was not checked when a failed check reported nothing", () => {
    expect(one("failed", none)).toMatchObject({ text: "$(warning) Bundle: not checked", warning: false });
  });

  test("says a bundle that was found but not checked yet is waiting, not clean", () => {
    const view = one("pending", none);
    expect(view?.text).toBe("$(circle-large-outline) Bundle: not checked yet");
    expect(view?.tooltip).toBe("Save a file or open the graph to check it.");
    expect(view?.warning).toBe(false);
  });

  test("is highlighted and says the CLI was not found when nothing could be checked", () => {
    const view = one("cli_missing", none);
    expect(view).toMatchObject({ text: "$(warning) Databricks CLI not found", warning: true });
    expect(view?.tooltip).toContain("Nothing is being checked");
  });

  test.each([
    [{ problem: "not_installed" }, "Databricks CLI not found", "install it or locate it"],
    [{ problem: "not_databricks_cli", versionOutput: "Version 0.18.0" }, "Legacy Databricks CLI (0.18.0)", "legacy databricks-cli pip package"],
    [{ problem: "not_databricks_cli", versionOutput: "jq-1.7.1" }, '"databricks" is another program', "is not the Databricks CLI"],
    [{ problem: "not_databricks_cli" }, '"databricks" is another program', "is not the Databricks CLI"],
    [{ problem: "configured_path_invalid" }, "Check the cliPath setting", "cliPath setting is not a working"],
  ] as const)("says why the CLI could not be used: %o", (issue, text, tooltip) => {
    const view = one("cli_missing", none, { cliIssue: issue });
    expect(view).toMatchObject({ text: `$(warning) ${text}`, warning: true });
    expect(view?.tooltip).toContain(tooltip);
    expect(view?.tooltip).toContain("Nothing is being checked");
    expect(bundleSummary("cli_missing", none, issue)).toBe(text);
  });
});

describe("statusBarView, several bundles", () => {
  const bundle = (name: string, state: BundleCheckState | undefined, count: BundleCount = none): BundleStatus => ({
    name,
    state,
    count,
  });

  test("covers the whole folder when every bundle is clean", () => {
    const view = statusBarView([bundle("sales", "checked"), bundle("marketing", "checked"), bundle("ops", "checked")]);
    expect(view).toMatchObject({ text: "$(pass) 3 bundles: no problems", warning: false });
    expect(view?.tooltip).toBe("");
    expect(view?.tooltipList).toEqual(["sales: no problems", "marketing: no problems", "ops: no problems"]);
    expect(view?.tooltipMore).toBeUndefined();
  });

  test("counts another bundle's problems, not only the one in view", () => {
    const view = statusBarView([bundle("sales", "checked"), bundle("marketing", "checked", { problems: 5, notes: 0 })]);
    expect(view?.text).toBe("$(warning) 2 bundles: 5 problems");
    expect(view?.tooltipList).toEqual(["marketing: 5 problems", "sales: no problems"]);
  });

  test("uses the folder count it is given, which counts a shared file once", () => {
    const view = statusBarView(
      [bundle("outer", "checked", { problems: 2, notes: 0 }), bundle("inner", "checked", { problems: 2, notes: 0 })],
      { problems: 2, notes: 0, graphOnly: 0 },
    );
    expect(view?.text).toBe("$(warning) 2 bundles: 2 problems");
  });

  test("never says 'no problems' about bundles it has not checked", () => {
    const bundles = [
      ...Array.from({ length: 3 }, (_, i) => bundle(`b${i}`, "checked")),
      ...Array.from({ length: 9 }, (_, i) => bundle(`later${i}`, "pending")),
    ];
    const view = statusBarView(bundles);
    expect(view?.text).toBe("$(pass) 3 of 12 bundles checked: no problems");
    expect(view?.tooltipList).toEqual(["b0: no problems", "b1: no problems", "b2: no problems"]);
    expect(view?.tooltipMore).toBe(9);
  });

  test("counts a failed check that reported nothing as not checked", () => {
    const view = statusBarView([bundle("sales", "checked"), bundle("broken", "failed")]);
    expect(view?.text).toBe("$(pass) 1 of 2 bundles checked: no problems");
    expect(view?.tooltipList).toContain("broken: not checked");
  });

  test("says nothing was checked yet rather than 'no problems'", () => {
    expect(statusBarView([bundle("a", "pending"), bundle("b", undefined)])?.text).toBe(
      "$(circle-large-outline) 2 bundles: not checked yet",
    );
  });

  test("shows notes when there are no problems", () => {
    expect(statusBarView([bundle("a", "checked", { problems: 0, notes: 2 }), bundle("b", "checked")])?.text).toBe(
      "$(info) 2 bundles: 2 notes",
    );
  });

  test("says the CLI is missing when any bundle could not be checked for that reason", () => {
    const view = statusBarView([
      bundle("sales", "checked"),
      { ...bundle("ops", "cli_missing"), cliIssue: { problem: "not_databricks_cli", versionOutput: "Version 0.18.0" } },
    ]);
    expect(view).toMatchObject({ text: "$(warning) Legacy Databricks CLI (0.18.0)", warning: true });
  });

  test("does not depend on which bundle is listed first", () => {
    const a = bundle("sales", "checked");
    const b = bundle("marketing", "checked", { problems: 5, notes: 0 });
    expect(statusBarView([a, b])?.text).toBe(statusBarView([b, a])?.text);
  });

  test("50 bundles: the text stays short, the tooltip lists the first 3, problems first, and links to the rest", () => {
    const bundles = Array.from({ length: 50 }, (_, i) =>
      bundle(`bundle_${i}`, i < 40 ? "checked" : "pending", { problems: i === 30 || i === 7 ? 1 : 0, notes: 0 }),
    );
    const view = statusBarView(bundles);
    expect(view?.text).toBe("$(warning) 40 of 50 bundles checked: 2 problems");
    expect(view?.tooltipList).toHaveLength(TOOLTIP_BUNDLE_LIMIT);
    expect(view?.tooltipList).toEqual(["bundle_7: 1 problem", "bundle_30: 1 problem", "bundle_0: no problems"]);
    expect(view?.tooltipMore).toBe(47);
  });
});

describe("checkingView", () => {
  const view = { text: "$(pass) Bundle: no problems · 12 tasks", tooltip: "Checked.", warning: false };

  test("swaps the icon for a turning one and keeps the result", () => {
    expect(checkingView(view, false)).toEqual({
      text: "$(sync~spin) Bundle: no problems · 12 tasks",
      tooltip: "Checking now. Checked.",
      warning: false,
    });
  });

  test("still says it is checking when the tooltip is only a list", () => {
    expect(checkingView({ ...view, tooltip: "" }, false).tooltip).toBe("Checking now.");
  });

  test("does not turn when the user asked VS Code for less motion", () => {
    expect(checkingView(view, true).text).toBe("$(sync) Bundle: no problems · 12 tasks");
  });
});

describe("bundleContents", () => {
  test("counts jobs, tasks, pipelines and local files from the graph", () => {
    expect(
      bundleContents({
        nodes: [
          { nodeType: "job" },
          { nodeType: "task" },
          { nodeType: "task" },
          { nodeType: "resource", resourceGroup: "pipelines" },
          { nodeType: "resource", resourceGroup: "schemas" },
          { nodeType: "file", location: "local" },
          { nodeType: "file", location: "workspace" },
          { nodeType: "variable" },
        ],
      }),
    ).toEqual({ jobs: 1, tasks: 2, pipelines: 1, files: 1 });
  });
});

describe("describeContents", () => {
  test.each([
    [{ jobs: 3, tasks: 12, pipelines: 1, files: 8 }, "3 jobs, 12 tasks, 1 pipeline and 8 files"],
    [{ jobs: 1, tasks: 1, pipelines: 0, files: 0 }, "1 job and 1 task"],
    [{ jobs: 0, tasks: 0, pipelines: 2, files: 0 }, "2 pipelines"],
    [{ jobs: 0, tasks: 0, pipelines: 0, files: 0 }, ""],
  ])("%o -> %s", (contents, text) => {
    expect(describeContents(contents)).toBe(text);
  });
});

describe("orderForPicking", () => {
  test("puts the bundle in view first and keeps the rest in the order found", () => {
    expect(orderForPicking(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
  });

  test("keeps the order found when no bundle is in view, or it is not in the list", () => {
    expect(orderForPicking(["/a", "/b"], undefined)).toEqual(["/a", "/b"]);
    expect(orderForPicking(["/a", "/b"], "/z")).toEqual(["/a", "/b"]);
  });
});

describe("bundleForFile", () => {
  const roots = ["/repo/teams/sales", "/repo", "/repo/teams/ops"];

  test("picks the bundle that holds the open file, the deepest when nested", () => {
    expect(bundleForFile(roots, "/repo/teams/sales/src/job.py", "/")).toBe("/repo/teams/sales");
    expect(bundleForFile(roots, "/repo/README.md", "/")).toBe("/repo");
  });

  test("does not take a folder for another whose name starts the same", () => {
    expect(bundleForFile(["/work/etl", "/work/etl-old"], "/work/etl-old/a.py", "/")).toBe("/work/etl-old");
  });

  test("is undefined with no file, or a file outside every bundle", () => {
    expect(bundleForFile(roots, undefined, "/")).toBeUndefined();
    expect(bundleForFile(["/a", "/b"], "/elsewhere/x.py", "/")).toBeUndefined();
  });

  test("works with Windows paths", () => {
    expect(bundleForFile(["c:\\proj\\etl"], "c:\\proj\\etl\\src\\a.py", "\\")).toBe("c:\\proj\\etl");
  });

  test("is undefined when no bundle is known", () => {
    expect(bundleForFile([], "/x.py", "/")).toBeUndefined();
  });
});
