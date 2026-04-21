import assert from "node:assert/strict";
import test from "node:test";
import { resolveSelectedJobKey } from "../webview/lib/jobSelection.js";

test("resolveSelectedJobKey keeps a valid user-selected job key", () => {
  const selectedJobKey = resolveSelectedJobKey(
    ["job-a", "job-b"],
    "job-b",
    "job-a",
  );

  assert.equal(selectedJobKey, "job-b");
});

test("resolveSelectedJobKey falls back to the initial selected job key", () => {
  const selectedJobKey = resolveSelectedJobKey(
    ["job-a", "job-b"],
    "job-missing",
    "job-a",
  );

  assert.equal(selectedJobKey, "job-a");
});

test("resolveSelectedJobKey falls back to the first job key", () => {
  const selectedJobKey = resolveSelectedJobKey(
    ["job-a", "job-b"],
    "job-missing",
    "job-unknown",
  );

  assert.equal(selectedJobKey, "job-a");
});

test("resolveSelectedJobKey returns an empty string when no jobs exist", () => {
  const selectedJobKey = resolveSelectedJobKey([], "job-a", "job-b");

  assert.equal(selectedJobKey, "");
});
