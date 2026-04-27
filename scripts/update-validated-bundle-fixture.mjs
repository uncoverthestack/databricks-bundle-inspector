#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TARGET = "__bundle_inspector_probe__";

function usage() {
  return [
    "Usage:",
    "  node scripts/update-validated-bundle-fixture.mjs --fixture <path> [--cli <path>] [--target <target>]",
    "",
    "Example:",
    "  npm run fixtures:update:validated-bundle -- --fixture src/test/fixtures/secret-scope-example --cli databricks",
  ].join("\n");
}

function readArgs(argv) {
  const options = {
    cli: "databricks",
    target: DEFAULT_TARGET,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--fixture" && next) {
      options.fixture = next;
      index += 1;
      continue;
    }
    if (arg === "--cli" && next) {
      options.cli = next;
      index += 1;
      continue;
    }
    if (arg === "--target" && next) {
      options.target = next;
      index += 1;
      continue;
    }
    if (arg === "--no-target") {
      options.target = undefined;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}\n\n${usage()}`);
  }

  if (options.help) {
    return options;
  }

  if (!options.fixture) {
    throw new Error(`Missing required --fixture argument.\n\n${usage()}`);
  }

  return options;
}

async function databricksVersion(cli) {
  const { stdout, stderr } = await execFileAsync(cli, ["--version"], {
    timeout: 30_000,
  });
  const output = `${stdout}\n${stderr}`.trim();
  const match = output.match(/v?\d+\.\d+\.\d+[^\s]*/);
  return match?.[0] ?? output;
}

async function validateBundle(cli, fixtureRoot, target) {
  const args = ["bundle", "validate", "--output", "json"];
  if (target) args.push("--target", target);

  try {
    const { stdout } = await execFileAsync(cli, args, {
      cwd: fixtureRoot,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      error.stdout.trim()
    ) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function canonicalJsonSha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const fixtureRoot = path.resolve(options.fixture);
  const [version, bundle] = await Promise.all([
    databricksVersion(options.cli),
    validateBundle(options.cli, fixtureRoot, options.target),
  ]);

  const validatedBundlePath = path.join(fixtureRoot, "validated-bundle.json");
  const metadataPath = path.join(fixtureRoot, "validated-bundle.meta.json");

  const metadata = {
    source: "databricks bundle validate --output json",
    databricksCliVersion: version,
    generatedAt: new Date().toISOString(),
    bundleTarget: options.target ?? "not specified",
    validatedBundleCanonicalSha256: canonicalJsonSha256(bundle),
    notes: [
      "This file records the source of validated-bundle.json for semantic graph baseline tests.",
      "Normal tests must not overwrite validated-bundle.json. Regenerate it only through this explicit fixture update workflow.",
      "The fixture is CLI-shaped JSON, not raw YAML parser output.",
    ],
  };

  await mkdir(fixtureRoot, { recursive: true });
  await writeFile(validatedBundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  console.log(`Updated ${validatedBundlePath}`);
  console.log(`Updated ${metadataPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
