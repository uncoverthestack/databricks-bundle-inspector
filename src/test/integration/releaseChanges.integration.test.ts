import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { extractBundleGraph, type ParsedBundleConfig } from "../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../bundle/issues.js";
import { bundleCliEnv } from "../../databricksCli/restrictedExecution.js";

// Exercise the post-0.6.2 fixes with the official CLI, including target resolution.
// Authentication and workspace requests go only to this local fake workspace.
const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
const cliSchema = execFileSync(cli, ["bundle", "schema"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15_000 });
const exec = promisify(execFile);
let root: string;
let server: Server;
let host: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dbi-release-stress-"));
  await writeFile(path.join(root, "empty.cfg"), "");
  server = createServer((request, response) => {
    const url = request.url?.split("?")[0] ?? "";
    const body = url.endsWith("/scim/v2/Me")
      ? { id: "1", userName: "stress@example.com", active: true }
      : url.endsWith("/workspace/get-status") ? { object_type: "DIRECTORY", path: "/fake" } : {};
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});

async function validated(dir: string, target: string) {
  const env = bundleCliEnv(dir, {
    ...process.env,
    DATABRICKS_HOST: host,
    DATABRICKS_TOKEN: "fake-token",
    DATABRICKS_AUTH_TYPE: "pat",
    DATABRICKS_CONFIG_FILE: path.join(root, "empty.cfg"),
    DATABRICKS_CONFIG_PROFILE: undefined,
  });
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await exec(cli, ["bundle", "validate", "-t", target, "-o", "json"], { cwd: dir, env, timeout: 15_000 }));
  } catch (error) {
    // A probe target is intentionally absent; failed real targets also print their config.
    const failed = error as { stdout?: string; stderr?: string };
    if (!failed.stdout?.trim()) throw error;
    stdout = failed.stdout;
    stderr = failed.stderr ?? "";
  }
  const raw = JSON.parse(stdout) as ParsedBundleConfig;
  return { data: { ...raw, bundle: raw.bundle ?? {} }, stderr };
}

describe("bundle names: preview findings match the official CLI", () => {
  test.each([
    ["no base name", "", "", true, false],
    ["empty base name", 'bundle: {name: ""}\n', "", true, false],
    ["empty target", "", "dev: null", true, false],
    ["inherited name", "bundle: {name: base}\n", "dev: null", false, false],
    ["target supplies name", "", "dev: {bundle: {name: target}}", false, false],
    ["target clears name", "bundle: {name: base}\n", 'dev: {bundle: {name: ""}}', true, false],
    ["nameless explicit folder", "workspace: {root_path: /Workspace/safe}\n", "", false, false],
    ["nameless interpolated folder", 'workspace: {root_path: "/Workspace/.bundle/${bundle.name}/${bundle.target}"}\n', "dev: null", false, true],
    ["target clears name in inherited folder", 'bundle: {name: base}\nworkspace: {root_path: "/Workspace/.bundle/${bundle.name}/${bundle.target}"}\n', 'dev: {bundle: {name: ""}}', false, true],
    ["target supplies name for inherited folder", 'workspace: {root_path: "/Workspace/.bundle/${bundle.name}/${bundle.target}"}\n', "dev: {bundle: {name: target}}", false, false],
    ["target replaces folder", 'workspace: {root_path: "/Workspace/.bundle/${bundle.name}/${bundle.target}"}\n', "dev: {workspace: {root_path: /Workspace/safe}}", false, false],
  ])("%s", async (label, base, target, missing, shared) => {
    const dir = path.join(root, label.replaceAll(" ", "-"));
    await mkdir(dir);
    await writeFile(path.join(dir, "databricks.yml"), `${base}targets:\n  ${target || "dev: {}"}\n`);
    const preview = await validated(dir, "__bundle_inspector_probe__");
    const resolved = await validated(dir, "dev");
    const issues = buildInspectorIssues({ nodes: [], edges: [] }, preview.data, [], dir);
    expect(issues.some(issue => issue.kind === "missing_bundle_name")).toBe(missing);
    expect(issues.some(issue => issue.kind === "empty_bundle_name_in_root_path")).toBe(shared);
    if (missing) expect(resolved.stderr).toMatch(/bundle name not defined/);
    else expect(resolved.stderr).not.toMatch(/Error:/);
    if (shared) expect((resolved.data.workspace as { root_path: string }).root_path).toContain("/.bundle//dev");
  });
});

describe("immutable target paths: checks read the actual local sources", () => {
  for (const [label, mode, field] of [
    ["normal", "", ""],
    ["immutable", "workspace: {sync_mode: immutable}\n", "sync_mode"],
    ["legacy immutable", "experimental: {immutable_folder: true}\n", "immutable_folder"],
  ] as const) {
    // The compatibility job also runs old CLIs. Report unsupported modes as skipped,
    // rather than passing when the CLI ignored an unknown field.
    const run = !field || cliSchema.includes(JSON.stringify(field)) ? test : test.skip;
    run(label, async () => {
      const dir = path.join(root, label.replaceAll(" ", "-"));
      await mkdir(path.join(dir, "src"), { recursive: true });
      await mkdir(path.join(dir, "resources"));
      await writeFile(path.join(dir, "src", "load.py"), '# Databricks notebook source\nvalue = dbutils.widgets.get("required_date")\n');
      await writeFile(path.join(dir, "src", "pipeline.sql"), "SELECT 1;\n");
      await writeFile(path.join(dir, "databricks.yml"), `bundle: {name: stress}\n${mode}include: [resources/*.yml]\ntargets: {dev: {}}\n`);
      await writeFile(path.join(dir, "resources", "job.yml"), "resources:\n  jobs:\n    job:\n      tasks:\n        - task_key: notebook\n          notebook_task: {notebook_path: ../src/load.py}\n  pipelines:\n    pipeline:\n      libraries:\n        - file: {path: ../src/pipeline.sql}\n");
      const resolved = await validated(dir, "dev");
      expect(resolved.stderr).not.toMatch(/Error:/);
      const notebook = resolved.data.resources?.jobs?.job?.tasks?.[0]?.notebook_task?.notebook_path;
      if (label !== "normal") expect(notebook).toMatch(/^\$\{(?:resources\.internal_immutable_snapshots\.immutable\.full_path|workspace\.snapshot_path)\}\/(?:src\/)?files\//);
      else expect(notebook).toMatch(/^\/Workspace\//);
      const graph = await enrichGraphWithFileContent(await extractBundleGraph(resolved.data, dir));
      const issues = buildInspectorIssues(graph, resolved.data, [], dir, "dev");
      expect(issues.some(issue => issue.kind === "widget_not_set")).toBe(true);
      expect(issues.some(issue => issue.kind === "path_not_checked")).toBe(false);
      expect(issues.some(issue => issue.kind === "missing_pipeline_source")).toBe(false);
      const ref = graph.nodes.find(node => node.taskData)?.taskData?.fileReferences[0];
      expect(ref).toMatchObject({ path: "../src/load.py", exists: true });
    });
  }
});
