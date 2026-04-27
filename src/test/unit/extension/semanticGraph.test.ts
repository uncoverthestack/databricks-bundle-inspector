import { describe, expect, test } from "@jest/globals";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { extractBundleGraph } from "../../../bundle/graph/bundleGraph.js";
import type { ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { exportSemanticGraph } from "../../../bundle/semanticGraph.js";
import type { SemanticBundleGraph } from "../../../bundle/semanticGraph.js";

const CASES = [
  {
    name: "secret-scope-example",
    fixture: "src/test/fixtures/secret-scope-example",
    baseline: "src/test/fixtures/baselines/secret-scope-example.semantic.json",
  },
  {
    name: "multi-job-dag",
    fixture: "src/test/fixtures/multi-job-dag",
    baseline: "src/test/fixtures/baselines/multi-job-dag.semantic.json",
  },
  {
    name: "broken-job",
    fixture: "src/test/fixtures/broken-job",
    baseline: "src/test/fixtures/baselines/broken-job.semantic.json",
  },
];

interface ValidatedBundleFixtureMeta {
  source: string;
  databricksCliVersion: string;
  generatedAt: string;
  bundleTarget: string;
  validatedBundleCanonicalSha256: string;
  notes: string[];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function canonicalJsonSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function readFixtureBundle(
  fixtureRoot: string,
): Promise<ParsedBundleConfig> {
  return JSON.parse(await readFixtureBundleContent(fixtureRoot)) as ParsedBundleConfig;
}

async function readFixtureBundleContent(fixtureRoot: string): Promise<string> {
  return readFile(path.join(fixtureRoot, "validated-bundle.json"), "utf-8");
}

async function readFixtureMeta(
  fixtureRoot: string,
): Promise<ValidatedBundleFixtureMeta> {
  return JSON.parse(
    await readFile(path.join(fixtureRoot, "validated-bundle.meta.json"), "utf-8"),
  ) as ValidatedBundleFixtureMeta;
}

describe("semantic graph baselines", () => {
  test.each(CASES)("$name matches the committed semantic baseline", async (testCase) => {
    const fixtureRoot = path.resolve(testCase.fixture);
    const meta = await readFixtureMeta(fixtureRoot);
    expect(meta).toMatchObject({
      source: "databricks bundle validate --output json",
      bundleTarget: "__bundle_inspector_probe__",
    });
    expect(meta.databricksCliVersion).toBeTruthy();
    expect(meta.generatedAt).toBeTruthy();

    const parsedBundle = await readFixtureBundle(fixtureRoot);
    expect(meta.validatedBundleCanonicalSha256).toBe(
      canonicalJsonSha256(parsedBundle),
    );

    const graph = await extractBundleGraph(parsedBundle, fixtureRoot);
    const enrichedGraph = await enrichGraphWithFileContent(graph);
    const issues = buildInspectorIssues(enrichedGraph, parsedBundle, [], fixtureRoot);
    const actual = exportSemanticGraph(parsedBundle, enrichedGraph, issues);

    const expected = JSON.parse(
      await readFile(path.resolve(testCase.baseline), "utf-8"),
    ) as SemanticBundleGraph;

    expect(actual).toEqual(expected);
  });
});
