import { describe, test, expect } from "@jest/globals";
import { bundleForFile, checkStateOf, statusBarView } from "../../../extension/statusBar.js";

describe("checkStateOf", () => {
  test("tells a missing CLI from other failures", () => {
    expect(checkStateOf({ ok: true })).toBe("checked");
    expect(checkStateOf({ ok: false, error: { errorCode: "CLI_NOT_FOUND" } })).toBe("cli_missing");
    expect(checkStateOf({ ok: false, error: { errorCode: "CLI_NOT_EXECUTABLE" } })).toBe("cli_missing");
    expect(checkStateOf({ ok: false, error: { errorCode: "VALIDATION_TIMEOUT" } })).toBe("failed");
    expect(checkStateOf({ ok: false, error: {} })).toBe("failed");
  });
});

describe("statusBarView", () => {
  test("is hidden when the folder has no bundle", () => {
    expect(statusBarView(undefined, 0, "", 0)).toBeUndefined();
  });

  test("says so when the checks ran and found nothing", () => {
    expect(statusBarView("checked", 0, "orders_etl", 0)).toMatchObject({
      text: "$(pass) Bundle: no problems",
      warning: false,
    });
  });

  test("counts the problems, with the right singular, and names the bundle", () => {
    expect(statusBarView("checked", 1, "orders_etl", 0)?.text).toBe("$(warning) Bundle: 1 problem");
    const view = statusBarView("checked", 3, "orders_etl", 0);
    expect(view?.text).toBe("$(warning) Bundle: 3 problems");
    expect(view?.tooltip).toContain('found 3 problems in "orders_etl"');
    expect(view?.tooltip).not.toContain("more bundle");
  });

  test("says when the folder holds more bundles than the one it counts", () => {
    expect(statusBarView("checked", 3, "orders_etl", 1)?.tooltip).toContain("has 1 more bundle.");
    expect(statusBarView("checked", 0, "orders_etl", 4)?.tooltip).toContain("has 4 more bundles.");
  });

  test("is highlighted and says the CLI was not found when nothing could be checked", () => {
    const view = statusBarView("cli_missing", 0, "orders_etl", 0);
    expect(view).toMatchObject({ text: "$(warning) Databricks CLI not found", warning: true });
    expect(view?.tooltip).toContain("Nothing is being checked");
  });

  test("says the bundle was not checked for any other failure", () => {
    expect(statusBarView("failed", 0, "orders_etl", 0)).toMatchObject({
      text: "$(warning) Bundle: not checked",
      warning: false,
    });
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

  test("falls back to the first bundle found with no file, or a file outside every bundle", () => {
    expect(bundleForFile(roots, undefined, "/")).toBe("/repo/teams/sales");
    expect(bundleForFile(["/a", "/b"], "/elsewhere/x.py", "/")).toBe("/a");
  });

  test("works with Windows paths", () => {
    expect(bundleForFile(["c:\\proj\\etl"], "c:\\proj\\etl\\src\\a.py", "\\")).toBe("c:\\proj\\etl");
  });

  test("is undefined when no bundle is known", () => {
    expect(bundleForFile([], "/x.py", "/")).toBeUndefined();
  });
});
