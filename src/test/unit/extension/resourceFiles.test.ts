import { describe, expect, test } from "@jest/globals";
import path from "node:path";
import { bundleThatLoaded, resourceAtLine } from "../../../bundle/resourceFiles.js";

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

const job = (key: string) => ({ group: "jobs", key });
const pipeline = (key: string) => ({ group: "pipelines", key });

describe("resourceAtLine", () => {
  test("picks the job whose definition holds the cursor", () => {
    expect(resourceAtLine(RESOURCE_FILE, 5)).toEqual(job("ingest"));
    expect(resourceAtLine(RESOURCE_FILE, 7)).toEqual(job("ingest"));
    expect(resourceAtLine(RESOURCE_FILE, 8)).toEqual(job("report"));
    expect(resourceAtLine(RESOURCE_FILE, 10)).toEqual(job("report"));
  });

  test("picks the pipeline whose definition holds the cursor", () => {
    expect(resourceAtLine(RESOURCE_FILE, 2)).toEqual(pipeline("bronze"));
    expect(resourceAtLine(RESOURCE_FILE, 3)).toEqual(pipeline("bronze"));
  });

  test("picks the first job when the cursor is in no definition", () => {
    expect(resourceAtLine(RESOURCE_FILE, 0)).toEqual(job("ingest"));
    expect(resourceAtLine(RESOURCE_FILE, 1)).toEqual(job("ingest"));
  });

  test("picks the first pipeline in a file with pipelines and no jobs", () => {
    const text = "resources:\n  pipelines:\n    bronze: {}\n    silver: {}\nvariables:\n  x:\n    default: 1\n";
    expect(resourceAtLine(text, 3)).toEqual(pipeline("silver"));
    expect(resourceAtLine(text, 0)).toEqual(pipeline("bronze"));
    expect(resourceAtLine(text, 6)).toEqual(pipeline("bronze"));
  });

  test("gives nothing for a file with no jobs or pipelines, or that isn't valid YAML", () => {
    expect(resourceAtLine("resources:\n  schemas:\n    raw: {}\n", 1)).toBeUndefined();
    expect(resourceAtLine("variables:\n  x: 1\n", 0)).toBeUndefined();
    expect(resourceAtLine("resources: [\n", 0)).toBeUndefined();
    expect(resourceAtLine("resources:\n  jobs:\n    ingest:\n      name: [broken\n", 3)).toBeUndefined();
    expect(resourceAtLine("resources: 3\n", 0)).toBeUndefined();
  });

  test("reads Windows line endings the same way", () => {
    expect(resourceAtLine(RESOURCE_FILE.replace(/\n/g, "\r\n"), 9)).toEqual(job("report"));
    expect(resourceAtLine(RESOURCE_FILE.replace(/\n/g, "\r\n"), 3)).toEqual(pipeline("bronze"));
  });

  test.each(["\n", "\r\n"])("falls back to the first job outside every definition (%j)", (eol) => {
    const text = [
      "resources:",
      "  jobs:",
      "    ingest:",
      "      name: ingest",
      "    report:",
      "      name: report",
      "  pipelines:",
      "    bronze:",
      "      name: bronze",
      "variables:",
      "  environment:",
      "    default: dev",
      "",
    ].join(eol);
    expect(resourceAtLine(text, 5)).toEqual(job("report"));
    expect(resourceAtLine(text, 8)).toEqual(pipeline("bronze"));
    expect(resourceAtLine(text, 11)).toEqual(job("ingest"));
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
