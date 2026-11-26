import { afterAll, describe, expect, test } from "@jest/globals";
import { parse } from "yaml";
import type { SourceFile } from "../../../bundle/jobStructure.js";
import {
  RUNTIME_RELEASES,
  findRuntimeSupportProblems,
  newestLts,
  runtimeName,
  runtimeSupport,
  runtimeVersionOf,
  todayForChecks,
} from "../../../bundle/runtimeSupport.js";

// Issue 485: a hint a month before a runtime's end of support, a warning after it.
const TODAY = "2026-11-24";

const sourceFile = (file: string, text: string): SourceFile => ({ file, doc: parse(text), text, locations: undefined });

describe("reading spark_version (issue 485)", () => {
  test.each([
    ["15.4.x-scala2.12", "15.4"],
    ["15.4.x-photon-scala2.12", "15.4"],
    ["15.4.x-cpu-ml-scala2.12", "15.4"],
    ["16.4.x-gpu-ml-scala2.12", "16.4"],
    ["18.x-scala2.13", "18"],
    ["19.x-scala2.13", "19"],
    [" 13.3.x-scala2.12 ", "13.3"],
  ])("%s is version %s", (value, version) => {
    expect(runtimeVersionOf(value)).toBe(version);
  });

  test.each(["custom:my-image", "apache-spark-3.5", "", "latest", "15.4-scala2.12"])("%j names no version", (value) => {
    expect(runtimeVersionOf(value)).toBeUndefined();
  });

  test("LTS versions are named as Databricks writes them", () => {
    expect(runtimeName("18")).toBe("18 LTS");
    expect(runtimeName("15.4")).toBe("15.4 LTS");
    expect(runtimeName("18.2")).toBe("18.2");
  });
});

describe("where a version stands (issue 485)", () => {
  test("past end of support", () => {
    expect(runtimeSupport("13.3", TODAY)).toEqual({ state: "past_end_of_support", version: "13.3", date: "2026-08-22" });
    expect(runtimeSupport("18.2", TODAY)).toMatchObject({ state: "past_end_of_support" });
  });

  test("end of support on the day itself counts as past", () => {
    expect(runtimeSupport("15.4", "2027-08-19").state).toBe("past_end_of_support");
  });

  test("a hint starts a month before end of support, not earlier", () => {
    expect(runtimeSupport("14.3", "2027-01-15")).toEqual({ state: "ends_soon", version: "14.3", date: "2027-02-01" });
    expect(runtimeSupport("14.3", TODAY).state).toBe("supported");
    expect(runtimeSupport("15.4", "2027-07-20").state).toBe("ends_soon");
    expect(runtimeSupport("15.4", "2027-07-19").state).toBe("supported");
  });

  test("current LTS versions and 19, which has no date yet, are fine", () => {
    for (const version of ["16.4", "17.3", "18", "19"]) expect(runtimeSupport(version, TODAY).state).toBe("supported");
  });

  test("10.4 LTS and earlier are past end of life, as Databricks says", () => {
    for (const version of ["10.4", "9.1", "7.3", "10.0"]) expect(runtimeSupport(version, TODAY).state).toBe("end_of_life");
    expect(runtimeSupport("10.5", TODAY).state).toBe("past_end_of_support");
  });

  test("a version the table doesn't know is never guessed", () => {
    expect(runtimeSupport("20", TODAY).state).toBe("unknown");
    expect(runtimeSupport("19.1", TODAY).state).toBe("unknown");
  });

  test("the table's dates are real dates, and LTS versions get three years", () => {
    for (const [version, release] of Object.entries(RUNTIME_RELEASES)) {
      if (release.endOfSupport) expect({ version, ok: !Number.isNaN(Date.parse(release.endOfSupport)) }).toEqual({ version, ok: true });
    }
    expect(newestLts()).toEqual({ version: "18", endOfSupport: "2029-06-10" });
  });
});

describe("findings in a bundle (issue 485)", () => {
  const yaml = `resources:
  clusters:
    shared:
      spark_version: 13.3.x-scala2.12
    fresh:
      spark_version: 18.x-scala2.13
  jobs:
    nightly:
      job_clusters:
        - job_cluster_key: main
          new_cluster:
            spark_version: 14.3.x-photon-scala2.12
      tasks:
        - task_key: old
          new_cluster:
            spark_version: 9.1.x-scala2.12
        - task_key: loop
          for_each_task:
            inputs: "[1]"
            task:
              task_key: inner
              new_cluster:
                spark_version: 18.2.x-scala2.13
        - task_key: shared_one
          existing_cluster_id: abc
targets:
  prod:
    resources:
      clusters:
        shared:
          spark_version: 12.2.x-scala2.12
`;
  const file = sourceFile("/b/databricks.yml", yaml);
  const resources = (file.doc as { resources: Record<string, unknown> }).resources;

  test("one finding per old version, at its line, worded by how far past it is", () => {
    const findings = findRuntimeSupportProblems(resources, [file], { today: "2027-01-15" });
    const shown = findings.map((f) => [f.resourceId, f.taskKey ?? null, f.severity, f.location?.line, f.title]);
    expect(shown).toEqual([
      ["resources.clusters.shared", null, "warning", 4, "Databricks Runtime 13.3 LTS may be past end of support and no longer gets security fixes."],
      ["resources.jobs.nightly", null, "info", 12, "Databricks Runtime 14.3 LTS is supported until 2027-02-01."],
      ["resources.jobs.nightly", "old", "warning", 16, "Databricks Runtime 9.1 may be past end of life. Runs on it may fail to start."],
      ["resources.jobs.nightly", "loop", "warning", 23, "Databricks Runtime 18.2 may be past end of support and no longer gets security fixes."],
    ]);
    expect(findings[0]!.fixHint).toContain("The newest LTS is 18 LTS, supported until 2029-06-10.");
  });

  test("with a target picked, its override's value and line are used", () => {
    const prodResources = { ...resources, clusters: { shared: { spark_version: "12.2.x-scala2.12" } } };
    const [shared] = findRuntimeSupportProblems(prodResources, [file], { today: TODAY, activeTarget: "prod" });
    expect([shared!.title, shared!.location?.line]).toEqual([
      "Databricks Runtime 12.2 LTS may be past end of support and no longer gets security fixes.",
      31,
    ]);
  });

  test("a variable counts once it resolves, and is skipped when it can't", () => {
    const withVariable = { clusters: { c: { spark_version: "${var.runtime}" } } };
    const varFile = sourceFile("/b/c.yml", "resources:\n  clusters:\n    c:\n      spark_version: ${var.runtime}\n");
    const resolved = findRuntimeSupportProblems(withVariable, [varFile], { today: TODAY, resolve: () => "13.3.x-scala2.12" });
    expect(resolved.map((f) => [f.severity, f.location?.line])).toEqual([["warning", 4]]);
    expect(findRuntimeSupportProblems(withVariable, [varFile], { today: TODAY, resolve: () => undefined })).toEqual([]);
    expect(findRuntimeSupportProblems(withVariable, [varFile], { today: TODAY })).toEqual([]);
  });

  test("near miss (runtime_end_of_support): a bundle with no clusters, or only current ones, has no findings", () => {
    expect(findRuntimeSupportProblems({}, [], { today: TODAY })).toEqual([]);
    expect(findRuntimeSupportProblems({ clusters: { a: { spark_version: "17.3.x-scala2.13" } } }, [], { today: TODAY })).toEqual([]);
  });
});

describe("the day the check uses (issue 485)", () => {
  const saved = process.env.DATABRICKS_BUNDLE_INSPECTOR_TODAY;
  afterAll(() => {
    if (saved === undefined) delete process.env.DATABRICKS_BUNDLE_INSPECTOR_TODAY;
    else process.env.DATABRICKS_BUNDLE_INSPECTOR_TODAY = saved;
  });

  test("the test runners' fixed day is used, so fixtures don't change as real dates pass", () => {
    process.env.DATABRICKS_BUNDLE_INSPECTOR_TODAY = "2030-01-02";
    expect(todayForChecks()).toBe("2030-01-02");
  });

  test("a value that isn't a date is ignored", () => {
    process.env.DATABRICKS_BUNDLE_INSPECTOR_TODAY = "tomorrow";
    expect(todayForChecks()).toBe(new Date().toISOString().slice(0, 10));
  });
});
