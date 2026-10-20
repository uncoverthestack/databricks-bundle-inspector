import { expect, test } from "@jest/globals";
import { readOptions } from "../e2e/options.js";

test("defaults only when no suite is supplied", () => {
  expect(readOptions([], {}).suite).toBe("cliNotFound");
  for (const args of [["--suite", "typo"], ["--suite", ""]]) {
    expect(() => readOptions(args, {})).toThrow(/Known suites:.*targets/);
  }
  expect(() => readOptions([], { E2E_SUITE: "typo" })).toThrow(/Unknown e2e suite/);
});

test("arguments override every legacy environment option", () => {
  expect(readOptions([
    "--suite", "targets", "--fixture", "folder with spaces", "--folder-case", "other",
    "--pause-ms", "15000", "--profile", "profile with spaces",
  ], { E2E_SUITE: "savedFile", E2E_FIXTURE: "old", E2E_PAUSE_MS: "1", INSPECTOR_TEST_PROFILE: "old" }))
    .toEqual({ suite: "targets", fixture: "folder with spaces", folderCase: "other", pauseMs: "15000", profile: "profile with spaces" });
});

test("legacy environment options still work", () => {
  expect(readOptions([], {
    E2E_SUITE: "targets", E2E_FIXTURE: "fixture", E2E_FOLDER_CASE: "other",
    E2E_PAUSE_MS: "100", INSPECTOR_TEST_PROFILE: "DEFAULT",
  })).toEqual({ suite: "targets", fixture: "fixture", folderCase: "other", pauseMs: "100", profile: "DEFAULT" });
});

test.each([["--suite"], ["--unknown", "targets"], ["--pause-ms", "NaN"], ["--pause-ms", "-1"], ["--folder-case", "typo"]])("rejects invalid arguments %j", (...args) => {
  expect(() => readOptions(args, {})).toThrow();
});
