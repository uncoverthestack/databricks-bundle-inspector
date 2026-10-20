import { describe, expect, test } from "@jest/globals";
import { cliAppliedTarget } from "../../../bundle/targetApplied.js";

const loggedIn = { workspace: { current_user: { userName: "someone@example.com" } } };

describe("cliAppliedTarget", () => {
  test("not before the login step, even with nothing to merge", () => {
    expect(cliAppliedTarget({ resources: { jobs: { j: { tasks: [{ task_key: "a" }] } } } })).toBe(false);
    expect(cliAppliedTarget({ workspace: {} })).toBe(false);
    expect(cliAppliedTarget(undefined)).toBe(false);
    expect(cliAppliedTarget("not a bundle")).toBe(false);
  });

  test("after the login step with nothing left to merge", () => {
    expect(cliAppliedTarget(loggedIn)).toBe(true);
    expect(
      cliAppliedTarget({
        ...loggedIn,
        resources: {
          jobs: {
            j: {
              tasks: [{ task_key: "a" }, { task_key: "b" }],
              job_clusters: [{ job_cluster_key: "c1" }, { job_cluster_key: "c2" }],
              parameters: [{ name: "p" }, { name: "q" }],
            },
          },
          pipelines: { p: { clusters: [{ label: "default" }, { label: "maintenance" }] } },
        },
      }),
    ).toBe(true);
  });

  // Each list the CLI merges by key, with its own key rule (resourcemutator/merge_*.go).
  test.each([
    ["two tasks with one task_key", { jobs: { j: { tasks: [{ task_key: "load" }, { task_key: "load" }] } } }],
    ["two tasks without a task_key", { jobs: { j: { tasks: [{}, {}] } } }],
    ["two job clusters with one key", { jobs: { j: { job_clusters: [{ job_cluster_key: "c" }, { job_cluster_key: "c" }] } } }],
    ["two job parameters with one name", { jobs: { j: { parameters: [{ name: "p" }, { name: "p" }] } } }],
    ["pipeline cluster labels differing only in case", { pipelines: { p: { clusters: [{ label: "Default" }, { label: "default" }] } } }],
    ["a pipeline cluster without a label and one labelled default", { pipelines: { p: { clusters: [{}, { label: "default" }] } } }],
    ["two app resources with one name", { apps: { a: { resources: [{ name: "wh" }, { name: "wh" }] } } }],
    ["two schema grants for one principal", { schemas: { s: { grants: [{ principal: "team" }, { principal: "team" }] } } }],
    ["two volume grants for one principal", { volumes: { v: { grants: [{ principal: "team" }, { principal: "team" }] } } }],
  ])("not when the CLI stopped before merging: %s", (_name, resources) => {
    expect(cliAppliedTarget({ ...loggedIn, resources })).toBe(false);
  });

  test("other lists with repeated values are not merge steps", () => {
    expect(
      cliAppliedTarget({
        ...loggedIn,
        resources: { jobs: { j: { tags: ["x", "x"], tasks: [{ task_key: "a", libraries: [{ whl: "w" }, { whl: "w" }] }] } } },
      }),
    ).toBe(true);
  });
});
