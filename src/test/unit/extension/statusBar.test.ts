import { describe, test, expect } from "@jest/globals";
import {
  bundleForFile,
  bundleSummary,
  checkStateOf,
  orderForPicking,
  statusBarView,
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

describe("statusBarView", () => {
  const none = { problems: 0, notes: 0 };

  test("is hidden when the folder has no bundle", () => {
    expect(statusBarView(undefined, none, "", 0)).toBeUndefined();
  });

  test("says so when the checks ran and found nothing", () => {
    expect(statusBarView("checked", none, "orders_etl", 0)).toMatchObject({
      text: "$(pass) Bundle: no problems",
      warning: false,
    });
  });

  test("counts the problems, with the right singular, and names the bundle", () => {
    expect(statusBarView("checked", { problems: 1, notes: 0 }, "orders_etl", 0)?.text).toBe(
      "$(warning) Bundle: 1 problem",
    );
    const view = statusBarView("checked", { problems: 3, notes: 0 }, "orders_etl", 0);
    expect(view?.text).toBe("$(warning) Bundle: 3 problems");
    expect(view?.tooltip).toContain('found 3 problems in "orders_etl".');
    expect(view?.tooltip).toContain("They are listed in the Problems panel. Click to open the graph.");
  });

  test("does not say 'no problems' when there are only notes", () => {
    const view = statusBarView("checked", { problems: 0, notes: 67 }, "orders_etl", 0);
    expect(view?.text).toBe("$(info) Bundle: 67 notes");
    expect(view?.tooltip).toContain("no errors or warnings");
    expect(statusBarView("checked", { problems: 0, notes: 1 }, "orders_etl", 0)?.text).toBe(
      "$(info) Bundle: 1 note",
    );
  });

  test("leads with the problems and mentions the notes in the tooltip", () => {
    const view = statusBarView("checked", { problems: 2, notes: 5 }, "orders_etl", 0);
    expect(view?.text).toBe("$(warning) Bundle: 2 problems");
    expect(view?.tooltip).toContain("and has 5 notes on it");
  });

  test("counts issues that have no file, and says they are only in the graph", () => {
    const all = statusBarView("checked", { problems: 2, notes: 0, graphOnly: 2 }, "orders_etl", 0);
    expect(all?.text).toBe("$(warning) Bundle: 2 problems");
    expect(all?.tooltip).toContain("They have no file to point at, so they show only in the graph.");
    expect(all?.tooltip).not.toContain("Problems panel");

    const some = statusBarView("checked", { problems: 3, notes: 1, graphOnly: 1 }, "orders_etl", 0);
    expect(some?.tooltip).toContain("1 of them has no file to point at and shows only in the graph.");
    expect(some?.tooltip).toContain("The rest are listed in the Problems panel.");
  });

  test("shows the errors of a check that failed, and says there may be more", () => {
    const view = statusBarView("failed", { problems: 1, notes: 0 }, "orders_etl", 0);
    expect(view?.text).toBe("$(warning) Bundle: 1 problem");
    expect(view?.tooltip).toContain("The check could not finish, so there may be more.");
  });

  test("says the bundle was not checked when a failed check reported nothing", () => {
    expect(statusBarView("failed", none, "orders_etl", 0)).toMatchObject({
      text: "$(warning) Bundle: not checked",
      warning: false,
    });
  });

  test("offers the other bundles when the folder holds more than one", () => {
    expect(statusBarView("checked", { problems: 3, notes: 0 }, "orders_etl", 1)?.tooltip).toContain(
      "or pick one of the 1 other bundle in this folder.",
    );
    expect(statusBarView("checked", none, "orders_etl", 4)?.tooltip).toContain(
      "or pick one of the 4 other bundles in this folder.",
    );
  });

  test("says a bundle that was found but not checked yet is waiting, not clean", () => {
    const view = statusBarView("pending", none, "orders_etl", 12);
    expect(view?.text).toBe("$(circle-large-outline) Bundle: not checked yet");
    expect(view?.tooltip).toContain("only the first few are checked");
    expect(view?.warning).toBe(false);
  });

  test("is highlighted and says the CLI was not found when nothing could be checked", () => {
    const view = statusBarView("cli_missing", none, "orders_etl", 0);
    expect(view).toMatchObject({ text: "$(warning) Databricks CLI not found", warning: true });
    expect(view?.tooltip).toContain("Nothing is being checked");
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
