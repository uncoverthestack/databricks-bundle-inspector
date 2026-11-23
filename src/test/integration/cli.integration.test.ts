import { afterAll, describe, expect, test } from "@jest/globals";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectorFindings } from "../../bundle/inspectBundle.js";
import { validateBundle } from "../../bundle/validateBundle.js";
import { runCli, type CliIo } from "../../cli/main.js";

const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
/** A ~/.databrickscfg profile for the --target cases that need a sign-in. CI has none. */
const profile = process.env.INSPECTOR_TEST_PROFILE?.trim() || undefined;
const repoRoot = path.resolve(__dirname, "../../..");
const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function run(argv: string[], cwd = repoRoot) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd, env: {}, isTty: false };
  const code = await runCli(argv, io);
  return { code, stdout, stderr };
}

async function tempBundle(prefix: string, yaml: string[], files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  await writeFile(path.join(dir, "databricks.yml"), [...yaml, ""].join("\n"));
  return dir;
}

const JOB = [
  "resources:",
  "  jobs:",
  "    nightly:",
  "      name: nightly",
  "      tasks:",
  "        - task_key: load",
  "          notebook_task:",
  "            notebook_path: ./src/load.py",
];
const NOTEBOOK = { "src/load.py": "# Databricks notebook source\nprint(1)\n" };

describe(`the command-line tool (${cli})`, () => {
  test.each(["widget-parameters", "broken-job", "task-values", "run-targets", "sync-exclusions"])(
    "reports what the Problems panel's checks find: %s",
    async (fixture) => {
      const dir = path.join(repoRoot, "src/test/fixtures", fixture);
      const { code, stdout } = await run(["check", dir, "--format", "json", "--databricks-cli", cli]);
      const json = JSON.parse(stdout);

      const result = await validateBundle(dir, undefined, cli);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { issues } = await inspectorFindings(result, dir);
      const key = (kind: string, file: string | undefined, line: number | undefined) => `${kind}@${file ?? ""}:${line ?? ""}`;
      const fromCore = issues.map((issue) => key(issue.kind, issue.file && path.relative(repoRoot, issue.file).split(path.sep).join("/"), issue.file ? issue.line : undefined)).sort();
      const fromCli = json.bundles[0].findings.map((f: { code: string; file?: string; line?: number }) => key(f.code, f.file, f.line)).sort();

      expect(fromCli).toEqual(fromCore);
      expect(fromCli.length).toBeGreaterThan(0);
      expect(code).toBe(issues.some((issue) => issue.severity === "error") ? 1 : 0);
    },
  );

  test("never runs the bundle's own scripts, and writes nothing into the bundle folder", async () => {
    const dir = await tempBundle(
      "dbi-cli-safe-",
      ["bundle:", "  name: tripwire", "experimental:", "  scripts:", '    preinit: "echo ran > PREINIT_RAN.txt"', ...JOB],
      NOTEBOOK,
    );
    const before = (await readdir(dir, { recursive: true })).sort();

    for (const format of ["text", "json", "markdown", "github"]) {
      const { code } = await run(["check", dir, "--format", format, "--databricks-cli", cli]);
      expect(code).toBe(0);
    }

    expect(existsSync(path.join(dir, "PREINIT_RAN.txt"))).toBe(false);
    expect((await readdir(dir, { recursive: true })).sort()).toEqual(before);
  });

  test("a bundle the CLI rejects: its errors, exit 1, and the other bundles still checked", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "dbi-cli-broken-"));
    created.push(parent);
    await mkdir(path.join(parent, "good", "src"), { recursive: true });
    await writeFile(path.join(parent, "good", "src", "load.py"), NOTEBOOK["src/load.py"]);
    await writeFile(path.join(parent, "good", "databricks.yml"), ["bundle:", "  name: good", ...JOB, ""].join("\n"));
    await mkdir(path.join(parent, "bad"));
    await writeFile(path.join(parent, "bad", "databricks.yml"), "bundle:\n  name: bad\nresources: [\n");

    const { code, stdout } = await run(["check", parent, "--format", "json", "--databricks-cli", cli], parent);
    const json = JSON.parse(stdout);

    expect(code).toBe(1);
    expect(json.bundles.map((b: { path: string; validated: boolean }) => `${b.path}:${b.validated}`)).toEqual(["bad:false", "good:true"]);
    expect(json.bundles[0].findings[0]).toMatchObject({ severity: "error", code: "cli_diagnostic" });
    expect(json.bundles[1].findings).toEqual([]);
  });

  test("--fail-on never reports but always passes", async () => {
    const dir = path.join(repoRoot, "src/test/fixtures/broken-job");
    const { code, stdout } = await run(["check", dir, "--fail-on", "never", "--databricks-cli", cli]);
    expect(code).toBe(0);
    expect(stdout).toContain("missing_file");
  });

  test("--output writes the report to a file and prints nothing", async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), "dbi-cli-out-"));
    created.push(out);
    const { stdout } = await run(["check", "src/test/fixtures/broken-job", "--format", "markdown", "--output", path.join(out, "r.md"), "--databricks-cli", cli]);
    expect(stdout).toBe("");
    expect(existsSync(path.join(out, "r.md"))).toBe(true);
  });

  test("setup problems exit with 3 and say what to do", async () => {
    const missing = await run(["check", "src/test/fixtures/broken-job", "--databricks-cli", path.join(os.tmpdir(), "no-such-databricks")]);
    expect(missing.code).toBe(3);
    expect(missing.stderr).toContain("is not a working Databricks CLI");
    expect(missing.stdout).toBe("");
  });

  // A shell script stands in for an old CLI; Windows can't run one by path.
  (process.platform === "win32" ? test.skip : test)("a Databricks CLI older than v0.299.0 exits with 3", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dbi-cli-old-"));
    created.push(dir);
    const fake = path.join(dir, "databricks");
    await writeFile(fake, '#!/bin/sh\necho "Databricks CLI v0.250.0"\n');
    chmodSync(fake, 0o755);
    const { code, stderr } = await run(["check", "src/test/fixtures/broken-job", "--databricks-cli", fake]);
    expect(code).toBe(3);
    expect(stderr).toContain("v0.250.0 is older than v0.299.0");
  });

  test("wrong usage exits with 2 before running anything", async () => {
    expect((await run(["check", "no-such-folder"])).code).toBe(2);
    expect((await run(["check", "--format", "sarif"])).code).toBe(2);
  });

  describe("--target", () => {
    const TARGETS = [
      "bundle:",
      "  name: dbi-cli-target",
      "targets:",
      "  dev:",
      "    default: true",
      "    workspace:",
      "      host: https://dbc-00000000-0000.cloud.databricks.com",
      // Valid YAML the CLI only warns about: before the fix, its warning hid a missing target's error.
      "  odd:",
      "    resources:",
      "      jobs:",
      "        nightly:",
      '          tasks: "not a list"',
    ];

    test("a target the bundle doesn't have is wrong usage (2), naming the targets it has", async () => {
      const dir = await tempBundle("dbi-cli-target-", [...TARGETS, ...JOB], NOTEBOOK);
      const { code, stdout, stderr } = await run(["check", dir, "--target", "prdo", "--databricks-cli", cli]);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain('has no target "prdo". Its targets: ');
      expect(stderr).toMatch(/dev/);
    });

    test("no sign-in is a setup problem (3), never a pass on the structural preview", async () => {
      const dir = await tempBundle("dbi-cli-target-", [...TARGETS, ...JOB], NOTEBOOK);
      const saved = { ...process.env };
      // No credentials anywhere: the SDK gives up before any request.
      process.env.DATABRICKS_CONFIG_FILE = path.join(dir, "no-such.databrickscfg");
      for (const name of Object.keys(process.env)) {
        if (/^DATABRICKS_(HOST|TOKEN|CONFIG_PROFILE|AUTH_TYPE|CLIENT_ID|CLIENT_SECRET|ACCOUNT_ID)$/.test(name)) delete process.env[name];
      }
      try {
        const { code, stdout, stderr } = await run(["check", dir, "--target", "dev", "--databricks-cli", cli]);
        expect(code).toBe(3);
        expect(stdout).toBe("");
        expect(stderr).toContain(`Can't check target "dev"`);
        expect(stderr).toContain("The Databricks CLI said:");
        expect(stderr).not.toContain("expected sequence");
      } finally {
        process.env = saved;
      }
    });

    (profile ? test : test.skip)("with a sign-in: each target's own files and values are checked", async () => {
      const dir = await tempBundle(
        "dbi-cli-target-",
        [
          "bundle:",
          "  name: dbi-cli-target",
          "variables:",
          "  nb:",
          "    default: ./src/load.py",
          "targets:",
          "  dev:",
          "    default: true",
          "  prod:",
          "    variables:",
          "      nb: ./src/missing_in_prod.py",
          "resources:",
          "  jobs:",
          "    nightly:",
          "      name: nightly",
          "      tasks:",
          "        - task_key: load",
          "          notebook_task:",
          "            notebook_path: ${var.nb}",
        ],
        { "src/load.py": '# Databricks notebook source\nrun_date = dbutils.widgets.get("run_date")\n' },
      );
      const kinds = (json: { bundles: Array<{ findings: Array<{ code: string }> }> }) => json.bundles[0]!.findings.map((f) => f.code);

      const preview = JSON.parse((await run(["check", dir, "--format", "json", "--databricks-cli", cli])).stdout);
      expect(preview.target).toBeNull();
      expect(kinds(preview)).toEqual(["path_not_checked"]);

      const dev = await run(["check", dir, "--format", "json", "-t", "dev", "-p", profile!, "--databricks-cli", cli]);
      expect(dev.code).toBe(0);
      expect(JSON.parse(dev.stdout).target).toBe("dev");
      expect(kinds(JSON.parse(dev.stdout))).toContain("widget_not_set");

      const prod = await run(["check", dir, "--format", "json", "-t", "prod", "-p", profile!, "--databricks-cli", cli]);
      expect(prod.code).toBe(1);
      expect(kinds(JSON.parse(prod.stdout))).toContain("missing_file");
    });
  });
});
