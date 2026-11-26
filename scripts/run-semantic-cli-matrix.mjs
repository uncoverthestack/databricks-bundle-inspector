#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CONFIG = "semantic-cli-matrix.config.json";
// The one test in jest.semantic-cli.config.cjs that reads the fixture. The config's other
// files ignore it, so they run once per CLI, not once per fixture.
const FIXTURE_TEST = "src/test/integration/semanticCli.integration.test.ts";

function usage() {
  return [
    "Usage:",
    "  node scripts/run-semantic-cli-matrix.mjs [--config <path>]",
    "",
    "The config file contains CLI commands and fixture/baseline pairs. For each CLI, the",
    "integration tests that don't read a fixture run once, then the fixture test runs once",
    "per fixture. A fixture with \"minCliVersion\" is skipped for older CLIs.",
  ].join("\n");
}

function readArgs(argv) {
  const options = { config: DEFAULT_CONFIG };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--config" && next) {
      options.config = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}\n\n${usage()}`);
  }
  return options;
}

async function readConfig(configPath) {
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  if (!Array.isArray(config.clis) || config.clis.length === 0) {
    throw new Error(`Matrix config must define a non-empty "clis" array.`);
  }
  if (!Array.isArray(config.fixtures) || config.fixtures.length === 0) {
    throw new Error(`Matrix config must define a non-empty "fixtures" array.`);
  }
  return config;
}

function cliVersion(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf-8" });
  const match = `${result.stdout ?? ""}${result.stderr ?? ""}`.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Could not read the version of ${command}`);
  return match.slice(1, 4).map(Number);
}

function isOlderThan(version, minimum) {
  const min = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== min[index]) return version[index] < min[index];
  }
  return false;
}

function runJest(label, env, jestArgs) {
  console.log(`\n[semantic-cli-matrix] ${label}`);
  const result = spawnSync("npm", ["run", "test:semantic:cli", "--", ...jestArgs], {
    env: {
      ...process.env,
      SEMANTIC_CLI_ARTIFACT_DIR:
        process.env.SEMANTIC_CLI_ARTIFACT_DIR ??
        path.join(".test-artifacts", "semantic-cli-matrix"),
      ...env,
    },
    stdio: "inherit",
  });
  return { label, status: result.status ?? 1 };
}

/** Every test in the config except the fixture test, against this CLI. */
function runOtherTests(cli) {
  return runJest(
    `${cli.name} x other integration tests`,
    { SEMANTIC_CLI_COMMAND: cli.command },
    ["--testPathIgnorePatterns", path.basename(FIXTURE_TEST)],
  );
}

/** Only the fixture test. Jest fails with "No tests found" if the path stops matching. */
function runFixture(cli, fixture) {
  return runJest(
    `${cli.name} x ${fixture.name}`,
    {
      SEMANTIC_CLI_COMMAND: cli.command,
      SEMANTIC_CLI_FIXTURE: fixture.fixture,
      SEMANTIC_CLI_BASELINE: fixture.baseline,
    },
    [FIXTURE_TEST],
  );
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const config = await readConfig(path.resolve(options.config));
  if (!existsSync(FIXTURE_TEST)) {
    throw new Error(`${FIXTURE_TEST} not found: update FIXTURE_TEST in this script.`);
  }
  const failures = [];

  for (const cli of config.clis) {
    if (!cli?.name || !cli?.command) {
      throw new Error(`Each CLI entry must include "name" and "command".`);
    }
    const version = cliVersion(cli.command);
    const others = runOtherTests(cli);
    if (others.status !== 0) failures.push(others);
    for (const fixture of config.fixtures) {
      if (!fixture?.name || !fixture?.fixture || !fixture?.baseline) {
        throw new Error(
          `Each fixture entry must include "name", "fixture", and "baseline".`,
        );
      }
      // A fixture using bundle features newer than this CLI would only test the CLI rejecting them.
      if (fixture.minCliVersion && isOlderThan(version, fixture.minCliVersion)) {
        console.log(
          `\n[semantic-cli-matrix] ${cli.name} x ${fixture.name}: skipped (needs CLI ${fixture.minCliVersion}+, found ${version.join(".")})`,
        );
        continue;
      }
      const result = runFixture(cli, fixture);
      if (result.status !== 0) failures.push(result);
    }
  }

  if (failures.length > 0) {
    console.error("\n[semantic-cli-matrix] Failures:");
    for (const failure of failures) {
      console.error(`- ${failure.label}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("\n[semantic-cli-matrix] All cases passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
