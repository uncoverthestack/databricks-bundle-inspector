#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CONFIG = "semantic-cli-matrix.config.json";

function usage() {
  return [
    "Usage:",
    "  node scripts/run-semantic-cli-matrix.mjs [--config <path>]",
    "",
    "The config file contains CLI commands and fixture/baseline pairs.",
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

function runCase(cli, fixture) {
  const env = {
    ...process.env,
    SEMANTIC_CLI_COMMAND: cli.command,
    SEMANTIC_CLI_FIXTURE: fixture.fixture,
    SEMANTIC_CLI_BASELINE: fixture.baseline,
    SEMANTIC_CLI_ARTIFACT_DIR:
      process.env.SEMANTIC_CLI_ARTIFACT_DIR ??
      path.join(".test-artifacts", "semantic-cli-matrix"),
  };

  const label = `${cli.name} x ${fixture.name}`;
  console.log(`\n[semantic-cli-matrix] ${label}`);
  const result = spawnSync("npm", ["run", "test:semantic:cli"], {
    env,
    stdio: "inherit",
  });

  return {
    label,
    status: result.status ?? 1,
  };
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const config = await readConfig(path.resolve(options.config));
  const failures = [];

  for (const cli of config.clis) {
    if (!cli?.name || !cli?.command) {
      throw new Error(`Each CLI entry must include "name" and "command".`);
    }
    for (const fixture of config.fixtures) {
      if (!fixture?.name || !fixture?.fixture || !fixture?.baseline) {
        throw new Error(
          `Each fixture entry must include "name", "fixture", and "baseline".`,
        );
      }
      const result = runCase(cli, fixture);
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
