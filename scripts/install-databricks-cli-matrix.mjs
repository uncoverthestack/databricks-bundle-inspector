#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_MIN_VERSION = "0.270.1";
const DEFAULT_INSTALL_DIR = ".tools/databricks-cli";
const DEFAULT_OUTPUT_CONFIG = "semantic-cli-matrix.local.json";
const DEFAULT_FIXTURE_CONFIG = "semantic-cli-matrix.config.json";
const DEFAULT_STRATEGY = "all";
const STRATEGIES = new Set(["all", "latest-patch-per-minor"]);

function usage() {
  return [
    "Usage:",
    "  node scripts/install-databricks-cli-matrix.mjs [--min <version>] [--strategy <all|latest-patch-per-minor>] [--install-dir <path>] [--output <path>] [--fixture-config <path>]",
    "",
    "Example:",
    "  npm run cli:install-matrix -- --min 0.270.1 --output semantic-cli-matrix.local.json",
    "",
    "Downloads Databricks CLI releases at or above --min,",
    "installs each binary under .tools/databricks-cli/<version>/, and writes a matrix config.",
  ].join("\n");
}

function readArgs(argv) {
  const options = {
    min: DEFAULT_MIN_VERSION,
    installDir: DEFAULT_INSTALL_DIR,
    output: DEFAULT_OUTPUT_CONFIG,
    fixtureConfig: DEFAULT_FIXTURE_CONFIG,
    strategy: DEFAULT_STRATEGY,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--min" && next) {
      options.min = next;
      index += 1;
      continue;
    }
    if (arg === "--strategy" && next) {
      if (!STRATEGIES.has(next)) {
        throw new Error(
          `Invalid strategy: ${next}. Expected one of: ${[...STRATEGIES].join(", ")}`,
        );
      }
      options.strategy = next;
      index += 1;
      continue;
    }
    if (arg === "--install-dir" && next) {
      options.installDir = next;
      index += 1;
      continue;
    }
    if (arg === "--output" && next) {
      options.output = next;
      index += 1;
      continue;
    }
    if (arg === "--fixture-config" && next) {
      options.fixtureConfig = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}\n\n${usage()}`);
  }

  return options;
}

function parseVersion(value) {
  const match = value.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return undefined;
  return {
    raw: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left, right) {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}

function latestPatchPerMinor(versions, minVersion) {
  const min = parseVersion(minVersion);
  if (!min) throw new Error(`Invalid minimum version: ${minVersion}`);

  const byMinor = new Map();
  for (const version of versions) {
    if (compareVersions(version, min) < 0) continue;
    const key = `${version.major}.${version.minor}`;
    const existing = byMinor.get(key);
    if (!existing || compareVersions(version, existing) > 0) {
      byMinor.set(key, version);
    }
  }

  return [...byMinor.values()].sort(compareVersions);
}

function versionsAtOrAbove(versions, minVersion) {
  const min = parseVersion(minVersion);
  if (!min) throw new Error(`Invalid minimum version∏: ${minVersion}`);
  return versions
    .filter((version) => compareVersions(version, min) >= 0)
    .sort(compareVersions);
}

function selectVersions(versions, minVersion, strategy) {
  if (strategy === "all") return versionsAtOrAbove(versions, minVersion);
  if (strategy === "latest-patch-per-minor") {
    return latestPatchPerMinor(versions, minVersion);
  }
  throw new Error(`Invalid strategy: ${strategy}`);
}

function githubJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent": "databricks-bundle-inspector-fixture-matrix",
            Accept: "application/vnd.github+json",
          },
        },
        (response) => {
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            resolve(githubJson(response.headers.location));
            return;
          }
          if (response.statusCode !== 200) {
            reject(new Error(`GitHub request failed ${response.statusCode}: ${url}`));
            response.resume();
            return;
          }
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch (error) {
              reject(error);
            }
          });
        },
      )
      .on("error", reject);
  });
}

async function fetchReleases() {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubJson(
      `https://api.github.com/repos/databricks/cli/releases?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

function platformAssetSuffix() {
  const platform = os.platform();
  const arch = os.arch();

  const platformName =
    platform === "linux"
      ? "linux"
      : platform === "darwin"
        ? "darwin"
        : platform === "win32"
          ? "windows"
          : undefined;
  const archName =
    arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;

  if (!platformName || !archName) {
    throw new Error(`Unsupported platform/arch: ${platform}/${arch}`);
  }
  return `${platformName}_${archName}.tar.gz`;
}

function releaseAssetUrl(version) {
  const suffix = platformAssetSuffix();
  return `https://github.com/databricks/cli/releases/download/v${version.raw}/databricks_cli_${version.raw}_${suffix}`;
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destination);
    https
      .get(url, { headers: { "User-Agent": "databricks-bundle-inspector" } }, (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          file.close();
          rm(destination, { force: true })
            .then(() => download(response.headers.location, destination))
            .then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          reject(new Error(`Download failed ${response.statusCode}: ${url}`));
          response.resume();
          return;
        }
        response.pipe(file);
        file.on("finish", () => {
          file.close(resolve);
        });
      })
      .on("error", async (error) => {
        file.close();
        await rm(destination, { force: true });
        reject(error);
      });
  });
}

async function installVersion(version, installDir) {
  const versionDir = path.resolve(installDir, version.raw);
  const binaryPath = path.join(versionDir, "databricks");
  await mkdir(versionDir, { recursive: true });

  const archivePath = path.join(versionDir, `databricks_cli_${version.raw}.tar.gz`);
  const url = releaseAssetUrl(version);
  console.log(`[cli-matrix] downloading ${version.raw}`);
  await download(url, archivePath);

  const extract = spawnSync("tar", ["-xzf", archivePath, "-C", versionDir], {
    stdio: "inherit",
  });
  if (extract.status !== 0) {
    throw new Error(`Failed to extract ${archivePath}`);
  }

  await chmod(binaryPath, 0o755);
  await rm(archivePath, { force: true });
  return binaryPath;
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const releases = await fetchReleases();
  const versions = releases
    .map((release) => parseVersion(String(release.tag_name ?? "")))
    .filter(Boolean);
  const selected = selectVersions(versions, options.min, options.strategy);
  if (selected.length === 0) {
    throw new Error(`No Databricks CLI versions found at or above ${options.min}`);
  }

  const fixtureConfig = JSON.parse(
    await readFile(path.resolve(options.fixtureConfig), "utf-8"),
  );
  const clis = [];
  for (const version of selected) {
    const binaryPath = await installVersion(version, options.installDir);
    clis.push({
      name: version.raw,
      command: binaryPath,
    });
  }

  const matrixConfig = {
    clis,
    fixtures: fixtureConfig.fixtures,
  };
  await writeFile(
    path.resolve(options.output),
    `${JSON.stringify(matrixConfig, null, 2)}\n`,
  );

  console.log(`[cli-matrix] wrote ${options.output}`);
  console.log(`[cli-matrix] installed ${clis.length} CLI versions`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
