import { describe, expect, test } from "@jest/globals";
import { variableSourceLocation } from "../../../webview/lib/variableSource.js";

const definition = { file: "/bundle/databricks.yml", line: 28, column: 14 };
const qaOverride = { file: "/bundle/databricks.yml", line: 80, column: 26 };
const sources = { job_schedule_cron: { definition, targets: { qa: qaOverride } } };

describe("variableSourceLocation", () => {
  test("opens the target's override in a target that sets one", () => {
    expect(variableSourceLocation(sources, "job_schedule_cron", "qa")).toEqual(qaOverride);
  });

  test("opens the top-level definition in a target that doesn't override it", () => {
    expect(variableSourceLocation(sources, "job_schedule_cron", "dev")).toEqual(definition);
  });

  test("opens the top-level definition in the structural preview, which has no target", () => {
    expect(variableSourceLocation(sources, "job_schedule_cron", null)).toEqual(definition);
  });

  test("has nothing to open for a variable set nowhere, or only in another target", () => {
    expect(variableSourceLocation(sources, "missing", "qa")).toBeUndefined();
    expect(
      variableSourceLocation({ only_qa: { targets: { qa: qaOverride } } }, "only_qa", "dev"),
    ).toBeUndefined();
    expect(variableSourceLocation(undefined, "job_schedule_cron", "qa")).toBeUndefined();
  });
});
