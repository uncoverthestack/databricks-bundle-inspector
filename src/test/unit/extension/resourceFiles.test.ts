import { describe, expect, test } from "@jest/globals";
import path from "node:path";
import { bundleThatLoaded, jobKeyAtLine } from "../../../bundle/resourceFiles.js";

const RESOURCE_FILE = [
  "resources:", // 0
  "  pipelines:", // 1
  "    bronze:", // 2
  "      name: bronze", // 3
  "  jobs:", // 4
  "    ingest:", // 5
  "      tasks:", // 6
  "        - task_key: load", // 7
  "    report:", // 8
  "      tasks:", // 9
  "        - task_key: summary", // 10
  "",
].join("\n");

describe("jobKeyAtLine", () => {
  test("picks the job whose definition holds the cursor", () => {
    expect(jobKeyAtLine(RESOURCE_FILE, 5)).toBe("ingest");
    expect(jobKeyAtLine(RESOURCE_FILE, 7)).toBe("ingest");
    expect(jobKeyAtLine(RESOURCE_FILE, 8)).toBe("report");
    expect(jobKeyAtLine(RESOURCE_FILE, 10)).toBe("report");
  });

  test("picks the first job when the cursor is above the jobs", () => {
    expect(jobKeyAtLine(RESOURCE_FILE, 0)).toBe("ingest");
    expect(jobKeyAtLine(RESOURCE_FILE, 3)).toBe("ingest");
  });

  test("gives nothing for a file with no jobs, or that isn't valid YAML", () => {
    expect(jobKeyAtLine("resources:\n  pipelines:\n    bronze: {}\n", 1)).toBeUndefined();
    expect(jobKeyAtLine("variables:\n  x: 1\n", 0)).toBeUndefined();
    expect(jobKeyAtLine("resources: [\n", 0)).toBeUndefined();
  });

  test("reads Windows line endings the same way", () => {
    expect(jobKeyAtLine(RESOURCE_FILE.replace(/\n/g, "\r\n"), 9)).toBe("report");
  });
});

describe("bundleThatLoaded", () => {
  const root = path.resolve("/work/bundle");
  const nested = path.join(root, "teams", "sales");
  const loaded = new Map([
    [root, new Set([path.join(root, "databricks.yml"), path.join(root, "resources", "job.yml"), path.join(nested, "resources", "shared.yml")])],
    [nested, new Set([path.join(nested, "databricks.yml"), path.join(nested, "resources", "shared.yml")])],
  ]);

  test("finds the bundle whose last check loaded the file", () => {
    expect(bundleThatLoaded(path.join(root, "resources", "job.yml"), loaded, () => false)).toBe(root);
  });

  test("gives nothing for a file no check loaded, even one in a bundle's folder", () => {
    expect(bundleThatLoaded(path.join(root, "resources", "unused.yml"), loaded, () => false)).toBeUndefined();
  });

  test("picks the deepest bundle when nested bundles both load the file", () => {
    expect(bundleThatLoaded(path.join(nested, "resources", "shared.yml"), loaded, () => false)).toBe(nested);
  });

  test("matches another letter case only where the folder ignores case", () => {
    const upper = path.join(root, "Resources", "JOB.yml");
    expect(bundleThatLoaded(upper, loaded, () => true)).toBe(root);
    expect(bundleThatLoaded(upper, loaded, () => false)).toBeUndefined();
  });
});
