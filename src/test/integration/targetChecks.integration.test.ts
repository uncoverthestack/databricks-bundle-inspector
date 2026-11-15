import { afterAll, describe, expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enrichGraphWithFileContent } from "../../bundle/graph/enrichGraph.js";
import { extractBundleGraph } from "../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../bundle/issues.js";
import { TARGET_CHECK_KINDS } from "../../bundle/targetChecks.js";
import { validateBundle } from "../../bundle/validateBundle.js";

const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
const FIXTURE = path.resolve("src/test/fixtures/target-checks");
const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

function cliVersion(): [number, number, number] {
  const output = spawnSync(cli, ["--version"], { encoding: "utf-8" });
  const version = `${output.stdout ?? ""}${output.stderr ?? ""}`.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1, 4).map(Number);
  if (!version) throw new Error(`Could not read the version of ${cli}`);
  return version as [number, number, number];
}

const VERSION = cliVersion();
/** Whether the CLI under test is this version or newer. */
function atLeast(major: number, minor: number, patch: number): boolean {
  const minimum = [major, minor, patch];
  for (let i = 0; i < 3; i++) if (VERSION[i] !== minimum[i]) return VERSION[i]! > minimum[i]!;
  return true;
}

interface Finding {
  kind: (typeof TARGET_CHECK_KINDS)[number];
  severity: "error" | "warning";
  file: string;
  line: number;
}

interface Expected {
  /** Text the CLI prints with no target, or null for "nothing but the sign-in error". */
  cli: string | null;
  findings: Finding[];
}

const at = (kind: Finding["kind"], severity: Finding["severity"], file: string, line: number): Finding => ({ kind, severity, file, line });
const none: Expected = { cli: null, findings: [] };
/** What an older CLI does with a field it doesn't know: warns and drops it, so no rule sees it. */
const unknownField = (field: string): Expected => ({ cli: `unknown field: ${field}`, findings: [] });

/**
 * One bundle per case in src/test/fixtures/target-checks, each with one mistake the CLI
 * only reports once it has picked a target (#389). Checked on Databricks CLI v1.26.0 and
 * v0.299.2 (the oldest supported), 2 runs each, on 2026-11-14.
 */
const CASES: Record<string, () => Expected> = {
  clean: () => none,
  "internal-resource": () =>
    atLeast(1, 16, 0)
      ? { cli: "Internal resources cannot be set in bundle configuration", findings: [at("internal_resource_set", "error", "databricks.yml", 5)] }
      : unknownField("internal_immutable_snapshots"),
  "empty-job": () => ({ cli: "job nightly is not defined", findings: [at("resource_not_defined", "error", "databricks.yml", 5)] }),
  "empty-pipeline": () => ({
    cli: "pipeline bronze is not defined",
    findings: [at("resource_not_defined", "error", "resources/pipeline.yml", 3)],
  }),
  "host-variable": () => ({
    cli: "Variable interpolation is not supported for fields that configure authentication",
    findings: [at("variable_in_auth_field", "warning", "databricks.yml", 7)],
  }),
  "target-host-variable": () => ({
    cli: "Variable interpolation is not supported for fields that configure authentication",
    findings: [at("variable_in_auth_field", "warning", "databricks.yml", 10)],
  }),
  "bundle-name-variable": () => ({
    cli: "Please do not use variable interpolation in the name of your bundle",
    findings: [at("variable_in_bundle_name", "warning", "databricks.yml", 2)],
  }),
  "engine-invalid": () => ({
    cli: 'invalid value "drect" for bundle.engine',
    findings: [at("invalid_engine", "error", "databricks.yml", 3)],
  }),
  "engine-terraform": () =>
    atLeast(1, 20, 0)
      ? { cli: "the Terraform deployment engine has been removed", findings: [at("terraform_engine_removed", "error", "databricks.yml", 3)] }
      : none,
  "bundle-terraform": () =>
    atLeast(1, 20, 0)
      ? { cli: "bundle.terraform is deprecated and has no effect", findings: [at("terraform_setting_has_no_effect", "warning", "databricks.yml", 3)] }
      : none,
  "script-no-content": () => ({ cli: "Script hello has no content", findings: [at("script_no_content", "error", "databricks.yml", 5)] }),
  "script-content-variable": () => ({
    cli: "Found ${bundle.name} in script hello",
    findings: [at("variable_in_script_content", "error", "databricks.yml", 5)],
  }),
  // $${HOME} is an escaped literal from v1.15.0; an older CLI still reads it as ${HOME}.
  "script-escaped-variable": () =>
    atLeast(1, 15, 0)
      ? none
      : { cli: "Found ${HOME} in script hello", findings: [at("variable_in_script_content", "error", "databricks.yml", 5)] },
  "script-env-resource": () =>
    atLeast(1, 8, 0)
      ? {
          cli: "${resources.jobs.nightly.id} cannot be used in scripts.hello.env.JOB_ID",
          findings: [at("script_env_reference_not_resolved", "error", "databricks.yml", 8)],
        }
      : unknownField("env"),
  "secret-plain-text": () =>
    atLeast(1, 12, 0)
      ? { cli: "Secret value must be a variable reference", findings: [at("secret_value_not_variable", "error", "databricks.yml", 9)] }
      : unknownField("secrets"),
  "secret-no-value": () =>
    atLeast(1, 12, 0)
      ? { cli: "Secret value must be a string", findings: [at("secret_value_not_variable", "error", "databricks.yml", 5)] }
      : unknownField("secrets"),
  "secret-variable-default": () =>
    atLeast(1, 12, 0)
      ? {
          cli: "Variable used for secret value must not have a default value",
          findings: [at("secret_variable_has_default", "error", "databricks.yml", 12)],
        }
      : unknownField("secrets"),
  // A target's value for the variable counts as a default: the CLI checks the merged config.
  "secret-target-variable-value": () =>
    atLeast(1, 12, 0)
      ? {
          cli: "Variable used for secret value must not have a default value",
          findings: [at("secret_variable_has_default", "error", "databricks.yml", 17)],
        }
      : unknownField("secrets"),
  "secret-variable": () => (atLeast(1, 12, 0) ? none : unknownField("secrets")),
};

/** The CLI's errors and warnings with no target, its sign-in blocked so nothing reaches a workspace. */
async function cliWithNoTarget(dir: string): Promise<string[]> {
  const config = path.join(dir, ".no-sign-in.cfg");
  await writeFile(config, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // An empty config file and token sign-in with no token: tested 2026-11-14 to never sign
    // in, with a profile named, a token cached, or two profiles for one host.
    DATABRICKS_CONFIG_FILE: config,
    DATABRICKS_AUTH_TYPE: "pat",
    DATABRICKS_BUNDLE_RESTRICTED_CODE_EXECUTION: "1",
    DATABRICKS_BUNDLE_TMP: path.join(dir, ".bundle-tmp"),
    DATABRICKS_BUNDLE_ROOT: dir,
    BUNDLE_ROOT: dir,
  };
  for (const name of ["DATABRICKS_TOKEN", "DATABRICKS_HOST", "DATABRICKS_CONFIG_PROFILE", "DATABRICKS_CLIENT_ID", "DATABRICKS_CLIENT_SECRET"]) {
    delete env[name];
  }
  const result = spawnSync(cli, ["bundle", "validate", "--output", "json"], { cwd: dir, env, encoding: "utf-8" });
  return (result.stderr ?? "")
    .split("\n")
    .filter((line) => /^(Error|Warning):/.test(line))
    .filter((line) => !/token is required|host is required for PAT|cannot configure default credentials|invalid character "\{" in host name/.test(line));
}

describe(`checks the CLI runs only once a target is picked (${cli} v${VERSION.join(".")})`, () => {
  test("the fixture has a case for every folder, and every case a folder", async () => {
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(FIXTURE).filter((name) => !name.includes(".")).sort()).toEqual(Object.keys(CASES).sort());
  });

  test.each(Object.keys(CASES))("%s", async (name) => {
    const expected = CASES[name]!();
    // Each case in a copy: the inspector gives each bundle folder its own temp folder.
    const dir = await mkdtemp(path.join(os.tmpdir(), `dbi-target-checks-${name}-`));
    created.push(dir);
    await cp(path.join(FIXTURE, name), dir, { recursive: true });

    // 1. The CLI itself, with no target: it still reports the problem (or nothing).
    const cliLines = await cliWithNoTarget(dir);
    if (expected.cli === null) expect(cliLines).toEqual([]);
    else expect(cliLines.join("\n")).toContain(expected.cli);

    // 2. The inspector's structural preview reports it, at the line it is written on.
    const result = await validateBundle(dir, undefined, cli);
    if (!result.ok) throw new Error(result.error.details ?? result.error.error);
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(result.data, dir, result.cliVersion ? { cliVersion: result.cliVersion } : {}));
    const issues = buildInspectorIssues(graph, result.data, result.issues ?? [], dir);
    const kinds: readonly string[] = TARGET_CHECK_KINDS;
    const findings = issues
      .filter((issue) => kinds.includes(issue.kind))
      .map((issue) => ({ kind: issue.kind, severity: issue.severity, file: path.relative(dir, issue.file ?? ""), line: issue.line }));
    expect(findings).toEqual(expected.findings);

    // 3. With a real target the CLI reports these itself, so the inspector adds none.
    const withTarget = buildInspectorIssues(graph, result.data, result.issues ?? [], dir, "dev");
    expect(withTarget.filter((issue) => kinds.includes(issue.kind))).toEqual([]);
  });
});
