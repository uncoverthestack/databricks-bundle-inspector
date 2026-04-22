import { describe, test, expect } from "@jest/globals";
import { resolveSelectedJobKey } from "../../../webview/lib/jobSelection.js";

describe("resolveSelectedJobKey", () => {
  test("resolveSelectedJobKey keeps a valid user-selected job key", () => {
    const selectedJobKey = resolveSelectedJobKey(
      ["job-a", "job-b"],
      "job-b",
      "job-a",
    );

    expect(selectedJobKey).toBe("job-b");
  });

  test("resolveSelectedJobKey falls back to the initial selected job key", () => {
    const selectedJobKey = resolveSelectedJobKey(
      ["job-a", "job-b"],
      "job-missing",
      "job-a",
    );
    expect(selectedJobKey).toBe("job-a");
  });

  test("resolveSelectedJobKey falls back to the first job key", () => {
    const selectedJobKey = resolveSelectedJobKey(
      ["job-a", "job-b"],
      "job-missing",
      "job-unknown",
    );
    expect(selectedJobKey).toBe("job-a");
  });

  test("resolveSelectedJobKey returns an empty string when no jobs exist", () => {
    const selectedJobKey = resolveSelectedJobKey([], "job-a", "job-b");
    expect(selectedJobKey).toBe("");
  });
});
