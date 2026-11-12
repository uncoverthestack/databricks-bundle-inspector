import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { bundleReviewReport } from "../../bundle/bundleReviewReport.js";
import { extractBundleGraph, type ParsedBundleConfig } from "../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../bundle/issues.js";
import { validateBundle } from "../../bundle/validateBundle.js";
import { bundleTempDir } from "../../databricksCli/restrictedExecution.js";

const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
const profile = process.env.INSPECTOR_TEST_PROFILE?.trim();
const warehouse = profile ? process.env.INSPECTOR_TEST_WAREHOUSE?.trim() : "shared-warehouse";
const run = promisify(execFile);
let root: string;
let remote: string;
let server: Server | undefined;
let user: { userName: string; short_name?: string; domain_friendly_name?: string; displayName?: string };
const saved = new Map<string, string | undefined>();
const setEnv = (name: string, value?: string) => {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
};

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dbi-review-410-"));
  await cp(path.resolve("src/test/fixtures/bundle-review"), root, { recursive: true });
  if (profile) {
    user = JSON.parse((await run(cli, ["current-user", "me", "-p", profile, "-o", "json"], { timeout: 60_000 })).stdout);
  } else {
    user = { userName: "review-user@example.org", short_name: "review-user", domain_friendly_name: "review-user", displayName: "Review User" };
    server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(_request.url?.includes("/Me") ? { ...user, id: "1", active: true }
        : _request.url?.includes("/sql/warehouses") ? { warehouses: [{ id: "warehouse-id", name: warehouse }] }
        : { object_type: "DIRECTORY" }));
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
    setEnv("DATABRICKS_HOST", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    setEnv("DATABRICKS_TOKEN", "fake-token");
    const empty = path.join(root, "empty.databrickscfg");
    await writeFile(empty, "");
    setEnv("DATABRICKS_CONFIG_FILE", empty);
    setEnv("DATABRICKS_CONFIG_PROFILE");
  }
  remote = `/Shared/${path.basename(root)}-${user.userName}`;
  const config = path.join(root, "databricks.yml");
  let configText = (await readFile(config, "utf8")).replaceAll("/Shared/dbi-report-410-${workspace.current_user.short_name}", remote);
  if (warehouse) configText = configText.replace("variables:\n", `variables:\n  warehouse:\n    lookup:\n      warehouse: ${JSON.stringify(warehouse)}\n`);
  await writeFile(config, configText);
  setEnv("BUNDLE_VAR_outside", "PRIVATE-410-OVERRIDE");
}, 60_000);

afterAll(async () => {
  try {
    if (profile && remote) {
      await run(cli, ["workspace", "delete", remote, "--recursive", "-p", profile], { timeout: 60_000 }).catch(error => {
        if (!/doesn't exist|does not exist|RESOURCE_DOES_NOT_EXIST/.test(String(error.stderr))) throw error;
      });
      let absent = false;
      try { await run(cli, ["workspace", "get-status", remote, "-p", profile], { timeout: 60_000 }); }
      catch (error) { absent = /doesn't exist|does not exist|RESOURCE_DOES_NOT_EXIST/.test(String((error as { stderr?: string }).stderr)); }
      expect(absent).toBe(true);
    }
  } finally {
    for (const [name, value] of saved) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    if (root) {
      await rm(bundleTempDir(root), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }
}, 120_000);

async function checked(target?: string) {
  const result = await validateBundle(root, target, cli, target ? profile : undefined);
  if (!result.ok) throw new Error(`${target ?? "preview"}: ${result.error.error} ${result.error.details ?? ""}`);
  return result;
}

describe(`bundle report from the real CLI (${profile ? "workspace" : "fake workspace"})`, () => {
  test("preview and real targets report names and values from the CLI, omitting outside values and user identity", async () => {
    const preview = await checked();
    for (const target of [undefined, "dev", "prod"]) {
      const result = target ? await checked(target) : preview;
      const parsed = result.data;
      const graph = await enrichGraphWithFileContent(await extractBundleGraph(parsed, root));
      const resolution = { ...parsed, variables: { ...preview.data.variables, ...parsed.variables }, targets: preview.data.targets } as ParsedBundleConfig;
      const issues = buildInspectorIssues(graph, resolution, result.issues ?? [], root, target);
      const markdown = bundleReviewReport(parsed, graph, issues, {
        bundleRoot: root, targetLabel: target ?? "structural preview", structuralPreview: !target,
        bundleFiles: [path.join(root, "databricks.yml")],
        ...(target ? { targetName: target } : {}), writtenBundle: preview.data, resolutionBundle: resolution,
        ...(result.cliVersion ? { cliVersion: result.cliVersion } : {}), extensionVersion: "test", checkedAt: new Date("2026-11-12T12:00:00Z"),
      });
      expect(markdown).toContain(`7 resources, ${warehouse ? 4 : 3} variables`);
      expect(markdown).toContain("resources/workloads.yml:");
      expect(markdown).toContain("resources/data.yml:");
      expect(markdown).toContain("notebook.py");
      expect(markdown).toContain("pipeline.sql");
      expect(markdown).toContain("```mermaid");
      expect(markdown).toContain("<details>");
      expect(markdown).not.toContain("PRIVATE-410-OVERRIDE");
      expect(markdown).not.toContain(user.userName);
      for (const field of [user.short_name, user.domain_friendly_name, user.displayName]) if (field) expect(markdown).not.toContain(field);
      if (target) {
        expect(parsed.variables?.outside?.value).toBe("PRIVATE-410-OVERRIDE");
        expect(String((parsed.resources?.jobs?.daily as { name?: string }).name)).toContain("PRIVATE-410-OVERRIDE");
        expect(markdown).toContain(target === "dev" ? "target-label" : "repository-label");
        expect(markdown).toContain("outside repository; value omitted");
        expect(markdown).toContain(`| Mode | ${target === "dev" ? "development" : "production"} |`);
        if (warehouse) {
          expect(parsed.variables?.warehouse?.value).toBeTruthy();
          expect(markdown).toContain(`| warehouse | ${parsed.variables!.warehouse!.value} | lookup |`);
        }
      } else {
        expect(markdown).toContain("repository-default");
        expect(markdown).toContain("${var.label}");
      }
    }
  }, 90_000);
});
