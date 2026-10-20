import { describe, expect, test } from "@jest/globals";
import { firstLine, targetFallback } from "../../../bundle/fallbackReason.js";

// The messages are the Databricks CLI's (1.21.0), as validateBundle passes them on.
describe("targetFallback: the short reason in the graph's note", () => {
  test.each([
    [
      "no login",
      {
        error: "Failed to validate Databricks bundle.",
        errorCode: "AUTH_NOT_CONFIGURED",
        details:
          "error: failed during request visitor: default auth: cannot configure default credentials, please check https://docs.databricks.com/en/dev-tools/auth.html#databricks-client-unified-authentication to configure credentials for your preferred authentication method. Config: config_file=/dev/null. Env: DATABRICKS_CONFIG_FILE",
      },
      "you're not logged in to Databricks",
    ],
    [
      "a profile that doesn't exist",
      {
        error: "Failed to validate Databricks bundle.",
        errorCode: "VALIDATION_FAILED",
        details:
          "error: cannot resolve bundle auth configuration: resolve: /home/me/.databrickscfg has no NO_SUCH_PROFILE_E2E profile configured. Config: profile=NO_SUCH_PROFILE_E2E",
      },
      'there\'s no login profile named "NO_SUCH_PROFILE_E2E"',
    ],
    [
      "several matching profiles",
      {
        error: "Failed to validate Databricks bundle.",
        errorCode: "VALIDATION_FAILED",
        details:
          "error: cannot resolve bundle auth configuration: resolve: https://ambiguous.example.invalid: multiple profiles matched: first-one, second one: please set DATABRICKS_CONFIG_PROFILE or provide --profile flag to specify one.",
      },
      "several login profiles match this workspace",
    ],
    [
      "a profile for another workspace",
      {
        error: "Failed to validate Databricks bundle.",
        errorCode: "VALIDATION_FAILED",
        details:
          "error: cannot resolve bundle auth configuration: the host in the profile (https://b.example.invalid) doesn’t match the host configured in the bundle (https://ambiguous.example.invalid)",
      },
      "the login profile is for a different workspace",
    ],
    [
      "a target removed from the bundle",
      {
        error: "Failed to validate Databricks bundle.",
        errorCode: "VALIDATION_FAILED",
        details: "error: no_such_target: no such target. Available targets: ambiguous, dev",
      },
      "the bundle has no such target",
    ],
    [
      "anything else: the CLI's first line",
      { error: "Failed to validate Databricks bundle.", errorCode: "VALIDATION_FAILED", details: "error: job undefined-job is not defined\nwarning: more" },
      "job undefined-job is not defined",
    ],
  ])("%s", (_name, error, reason) => {
    expect(targetFallback(error).reason).toBe(reason);
  });

  test("a timeout says how long it waited, not Node's command text", () => {
    const fallback = targetFallback({
      error: "Databricks bundle validation timed out after 15 seconds.",
      errorCode: "VALIDATION_TIMEOUT",
      details: "Command failed: databricks bundle validate --output json --target dev",
    });
    expect(fallback).toEqual({
      message: "Databricks bundle validation timed out after 15 seconds.",
      reason: "the workspace didn't answer within 15 seconds",
    });
  });

  test("the whole message is kept for the tooltip and the profile choice", () => {
    const details = "error: one\nerror: two";
    expect(targetFallback({ error: "Failed", errorCode: "VALIDATION_FAILED", details }).message).toBe(details);
    expect(targetFallback({ error: "Failed to validate Databricks bundle." }).message).toBe(
      "Failed to validate Databricks bundle.",
    );
  });

  test("a long unknown line is cut short", () => {
    const reason = targetFallback({ error: "Failed", details: `error: ${"x".repeat(300)}` }).reason;
    expect(reason.length).toBeLessThanOrEqual(100);
    expect(reason.endsWith("…")).toBe(true);
  });
});

describe("firstLine", () => {
  test.each([
    ["Error: cannot configure default credentials", "cannot configure default credentials"],
    ["error: notebook src/nope.py not found", "notebook src/nope.py not found"],
    ["\n\n  error: first\nsecond", "first"],
    ["no prefix here", "no prefix here"],
    ["", ""],
  ])("%j shows %j", (message, shown) => {
    expect(firstLine(message)).toBe(shown);
  });
});
