import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues, unsupportedGlob } from "../../../bundle/issues.js";

// #530, live on CLI v1.27.0 (2026-11-24, twice each): `bundle validate` passes every form;
// deploy refuses all but a plain path and a trailing `/**`.
describe("unsupportedGlob", () => {
  test.each([
    // Refused: "Single asterisk glob pattern is not supported ... Use a double asterisk '**'".
    ["../src/dlt/*", "single", "../src/dlt/**"],
    ["../src/dlt/*.sql", "single", "../src/dlt/**"],
    ["../src/dlt/**/*.sql", "single", undefined],
    ["../src/*/t.sql", "other", undefined],
    // Refused: "Special characters *?\ are reserved".
    ["../src/**/t.sql", "other", undefined],
    ["../src/dlt/t.sq?", "other", "../src/dlt/**"],
  ])("%s is refused", (include, kind, suggestion) => {
    const result = unsupportedGlob(include);
    expect(result?.title).toBe(
      kind === "single"
        ? "Pipeline glob uses a single *, which Databricks doesn't accept, so deploy may fail."
        : "Pipeline glob uses * or ? where Databricks doesn't accept them, so deploy may fail.",
    );
    expect(result?.suggestion).toBe(suggestion);
  });

  test.each(["../src/dlt/**", "../src/dlt/t.sql", "../src/dlt", "/Workspace/Shared/dlt/**", "${var.dir}/**"])(
    "%s deploys",
    (include) => {
      expect(unsupportedGlob(include)).toBeUndefined();
    },
  );
});

describe("a refused pipeline glob through the graph (#530)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "dbi-glob-forms-"));
    mkdirSync(path.join(root, "resources"));
    mkdirSync(path.join(root, "src", "dlt"), { recursive: true });
    writeFileSync(path.join(root, "src", "dlt", "t.sql"), "CREATE MATERIALIZED VIEW a AS SELECT 1;\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const issuesFor = async (include: string) => {
    writeFileSync(
      path.join(root, "resources", "p.yml"),
      `resources:\n  pipelines:\n    p:\n      libraries:\n        - glob:\n            include: ${include}\n`,
    );
    const config = {
      bundle: { name: "forms" },
      include: ["resources/p.yml"],
      resources: { pipelines: { p: { libraries: [{ glob: { include } }] } } },
    } as unknown as ParsedBundleConfig;
    const graph = await extractBundleGraph(config, root);
    return buildInspectorIssues(graph, config, [], root).filter((issue) => issue.kind !== "cli_diagnostic");
  };

  test("one error with a quick fix to **, and no second finding for the same glob", async () => {
    expect(await issuesFor("../src/dlt/*")).toMatchObject([
      {
        severity: "error",
        kind: "missing_pipeline_source",
        title: "Pipeline glob uses a single *, which Databricks doesn't accept, so deploy may fail.",
        detail: '../src/dlt/*. Did you mean "../src/dlt/**"?',
        fix: { oldText: "../src/dlt/*", newText: "../src/dlt/**" },
        line: 6,
      },
    ]);
  });

  test("a folder ending in /** that has files gets nothing", async () => {
    expect(await issuesFor("../src/dlt/**")).toEqual([]);
  });
});
