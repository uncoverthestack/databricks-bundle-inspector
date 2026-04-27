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

async function validateBundle(
  cli: string,
  fixtureRoot: string,
  target: string | undefined,
): Promise<ParsedBundleConfig> {
  const args = ["bundle", "validate", "--output", "json"];
  if (target) args.push("--target", target);

  try {
    const { stdout } = await execFileAsync(cli, args, {
      cwd: fixtureRoot,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(stdout) as ParsedBundleConfig;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      error.stdout.trim()
    ) {
      return JSON.parse(error.stdout) as ParsedBundleConfig;
    }
    throw error;
  }
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

    const [cliVersion, parsedBundle] = await Promise.all([
      databricksVersion(cli),
      validateBundle(cli, fixtureRoot, target),
    ]);
    const graph = await extractBundleGraph(parsedBundle, fixtureRoot);
    const enrichedGraph = await enrichGraphWithFileContent(graph);
    const issues = buildInspectorIssues(
      enrichedGraph,
      parsedBundle,
      [],
      fixtureRoot,
    );
    const actual = exportSemanticGraph(parsedBundle, enrichedGraph, issues);
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
