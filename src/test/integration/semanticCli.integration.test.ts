import { describe, expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildInspectorIssues } from "../../bundle/issues.js";
import { enrichGraphWithFileContent } from "../../bundle/graph/enrichGraph.js";
import { extractBundleGraph } from "../../bundle/graph/bundleGraph.js";
import type { ParsedBundleConfig } from "../../bundle/graph/bundleGraph.js";
import { exportSemanticGraph } from "../../bundle/semanticGraph.js";
import type { SemanticBundleGraph } from "../../bundle/semanticGraph.js";
import { validateBundle as validateBundleWithCli } from "../../bundle/validateBundle.js";
import type { ValidationIssue } from "../../bundle/validateBundle.js";

const execFileAsync = promisify(execFile);
const DEFAULT_FIXTURE = "src/test/fixtures/secret-scope-example";
const DEFAULT_BASELINE =
  "src/test/fixtures/baselines/secret-scope-example.semantic.json";
const DEFAULT_TARGET = "__bundle_inspector_probe__";

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
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

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function databricksVersion(cli: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(cli, ["--version"], {
    timeout: 30_000,
  });
  const output = `${stdout}\n${stderr}`.trim();
  const match = output.match(/v?\d+\.\d+\.\d+[^\s]*/);
  return match?.[0] ?? output;
}

/**
 * Runs the extension's own validation path (CLI resolution, probe target,
 * stderr diagnostics parsing) so the matrix covers what users see, not only
 * the JSON on stdout.
 */
async function validateBundle(
  cli: string,
  fixtureRoot: string,
  target: string | undefined,
): Promise<{ bundle: ParsedBundleConfig; validationIssues: ValidationIssue[] }> {
  const result = await validateBundleWithCli(fixtureRoot, target, cli);
  if (!result.ok) {
    throw new Error(`bundle validate failed: ${JSON.stringify(result.error)}`);
  }
  return { bundle: result.data, validationIssues: result.issues ?? [] };
}

async function writeArtifacts(
  artifactRoot: string,
  cliVersion: string,
  fixtureRoot: string,
  target: string | undefined,
  bundle: ParsedBundleConfig,
  semanticGraph: SemanticBundleGraph,
): Promise<void> {
  const artifactDir = path.join(
    artifactRoot,
    safePathPart(cliVersion),
    path.basename(fixtureRoot),
  );
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    path.join(artifactDir, "validated-bundle.json"),
    `${JSON.stringify(bundle, null, 2)}\n`,
  );
  await writeFile(
    path.join(artifactDir, "semantic.json"),
    `${JSON.stringify(semanticGraph, null, 2)}\n`,
  );
  await writeFile(
    path.join(artifactDir, "meta.json"),
    `${JSON.stringify(
      {
        source: "databricks bundle validate --output json",
        databricksCliVersion: cliVersion,
        generatedAt: new Date().toISOString(),
        bundleTarget: target ?? "not specified",
        validatedBundleCanonicalSha256: canonicalJsonSha256(bundle),
      },
      null,
      2,
    )}\n`,
  );
}

describe("live Databricks CLI semantic compatibility", () => {
  test("CLI output matches the committed semantic graph baseline", async () => {
    const cli = env("SEMANTIC_CLI_COMMAND", "databricks");
    const fixtureRoot = path.resolve(env("SEMANTIC_CLI_FIXTURE", DEFAULT_FIXTURE));
    const baselinePath = path.resolve(
      env("SEMANTIC_CLI_BASELINE", DEFAULT_BASELINE),
    );
    const artifactRoot = path.resolve(
      env("SEMANTIC_CLI_ARTIFACT_DIR", ".test-artifacts/semantic-cli"),
    );
    const target =
      process.env.SEMANTIC_CLI_NO_TARGET === "1"
        ? undefined
        : env("SEMANTIC_CLI_TARGET", DEFAULT_TARGET);

    const [cliVersion, { bundle: parsedBundle, validationIssues }] =
      await Promise.all([
        databricksVersion(cli),
        validateBundle(cli, fixtureRoot, target),
      ]);
    const graph = await extractBundleGraph(parsedBundle, fixtureRoot);
    const enrichedGraph = await enrichGraphWithFileContent(graph);
    const issues = buildInspectorIssues(
      enrichedGraph,
      parsedBundle,
      validationIssues,
      fixtureRoot,
    );
    const actual = exportSemanticGraph(
      parsedBundle,
      enrichedGraph,
      issues,
      fixtureRoot,
    );
    await writeArtifacts(
      artifactRoot,
      cliVersion,
      fixtureRoot,
      target,
      parsedBundle,
      actual,
    );

    const expected = JSON.parse(
      await readFile(baselinePath, "utf-8"),
    ) as SemanticBundleGraph;
    expect(actual).toEqual(expected);
  });
});
