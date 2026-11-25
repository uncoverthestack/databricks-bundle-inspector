import { describe, expect, test } from "@jest/globals";
import { missingJobsReason } from "../../../webview/lib/missingJobsReason.js";

// Issue 549. The shapes below are what `bundle validate -t __bundle_inspector_probe__ -o json`
// gives (CLI v1.28.0) for the official bundle examples named in each test.
const PYTHON = "Jobs defined in Python may be missing: the inspector doesn't run bundle code.";

describe("why an empty bundle may still have jobs (#549)", () => {
  test("pydabs: a python section with resources", () => {
    const bundle = { python: { resources: ["resources:load_resources"], venv_path: ".venv" }, targets: { dev: {}, prod: {} } };
    expect(missingJobsReason(bundle)).toBe(PYTHON);
  });

  test("target_includes: jobs only under targets, named in order", () => {
    const bundle = {
      targets: {
        dev: { resources: { jobs: { "set1-job-1": {}, "set1-job-2": {} } } },
        prod: { resources: { jobs: { "set2-job-1": {} } } },
        staging: { resources: { jobs: { "set1-job-1": {} } } },
      },
    };
    expect(missingJobsReason(bundle)).toBe(
      "Jobs set inside the dev, prod and staging targets may be missing until you pick one.",
    );
  });

  test("one target, two targets, and more than three", () => {
    const withJobs = (...names: string[]) => ({
      targets: Object.fromEntries(names.map((name) => [name, { resources: { jobs: { a: {} } } }])),
    });
    expect(missingJobsReason(withJobs("dev"))).toBe("Jobs set inside the dev target may be missing until you pick it.");
    expect(missingJobsReason(withJobs("dev", "prod"))).toBe(
      "Jobs set inside the dev and prod targets may be missing until you pick one.",
    );
    expect(missingJobsReason(withJobs("a", "b", "c", "d", "e"))).toBe(
      "Jobs set inside the a, b, c and 2 more targets may be missing until you pick one.",
    );
  });

  test("pipelines only under a target say pipelines", () => {
    const bundle = { targets: { dev: { resources: { pipelines: { etl: {} } } } } };
    expect(missingJobsReason(bundle)).toBe("Pipelines set inside the dev target may be missing until you pick it.");
  });

  test("Python wins when both apply", () => {
    const bundle = { python: { resources: ["resources:load_resources"] }, targets: { dev: { resources: { jobs: { a: {} } } } } };
    expect(missingJobsReason(bundle)).toBe(PYTHON);
  });

  test("the target already picked is not named", () => {
    const bundle = { targets: { dev: { resources: { jobs: { a: {} } } }, prod: { resources: { jobs: { b: {} } } } } };
    expect(missingJobsReason(bundle, "dev")).toBe("Jobs set inside the prod target may be missing until you pick it.");
    expect(missingJobsReason({ targets: { dev: bundle.targets.dev } }, "dev")).toBeUndefined();
  });

  test("a bundle that really has none keeps the old line", () => {
    expect(missingJobsReason(undefined)).toBeUndefined();
    expect(missingJobsReason({})).toBeUndefined();
    expect(missingJobsReason({ python: { resources: [] }, targets: { dev: {}, prod: { resources: {} } } })).toBeUndefined();
    // Only other resource types under a target: not jobs or pipelines.
    expect(missingJobsReason({ targets: { dev: { resources: { schemas: { s: {} } } } } })).toBeUndefined();
    // python with only mutators adds no resources.
    expect(missingJobsReason({ python: { mutators: ["m:f"] } } as never)).toBeUndefined();
  });
});
