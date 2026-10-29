import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { extractBundleGraph, type BundleGraph, type ParsedBundleConfig } from "../../bundle/graph/bundleGraph.js";
import { withPreviewVariableReferences } from "../../bundle/graph/previewVariableReferences.js";
import { resolveExpressionForTarget, resolveVariableForTarget } from "../../bundle/targetResolution.js";
import { validateBundle } from "../../bundle/validateBundle.js";

/**
 * The variables fixtures through a real Databricks CLI, with a workspace to resolve
 * against: does the inspector show, for each target, the value the CLI deploys?
 *
 * Without INSPECTOR_TEST_PROFILE (CI): a fake workspace on 127.0.0.1 answers the few
 * calls `bundle validate` makes, so nothing real is contacted. With it: your profile's
 * workspace, one target at a time. Lookups then need INSPECTOR_TEST_WAREHOUSE, the
 * name or ID of a SQL warehouse there; without it the lookup is left out. Nothing about the
 * workspace is written into the repository. A real workspace gets an empty
 * `.bundle/dbi-variables-it/<target>/files` folder per target, as any validate does.
 */
const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
const profile = process.env.INSPECTOR_TEST_PROFILE?.trim() || undefined;
const warehouse = process.env.INSPECTOR_TEST_WAREHOUSE?.trim() || undefined;
const mode = profile ? "workspace" : "fake workspace";
const TARGETS = ["dev", "staging", "qa", "prod"];
const FAKE_WAREHOUSE = { id: "wh-lookup-1", name: "shared-warehouse" };
/** The warehouse the lookup must resolve to, when known. */
let expectedWarehouseId: string | undefined = profile ? undefined : FAKE_WAREHOUSE.id;

let root: string;
let server: Server | undefined;
let requests = 0;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined) {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function startFakeWorkspace(): Promise<string> {
  server = createServer((request, response) => {
    requests += 1;
    const url = request.url?.split("?")[0] ?? "";
    const body = url.endsWith("/scim/v2/Me")
      ? { id: "1", userName: "tester@example.com", active: true }
      : url === "/api/2.0/sql/warehouses"
        ? { warehouses: [FAKE_WAREHOUSE] }
        : url.endsWith("/workspace/get-status")
          ? { object_type: "DIRECTORY", path: "/fake" }
          : {};
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dbi-variables-cli-"));
  for (const fixture of ["variables", "variable-mistakes"]) {
    await cp(path.resolve("src/test/fixtures", fixture), path.join(root, fixture), { recursive: true });
  }
  if (profile) {
    const file = path.join(root, "variables", "databricks.yml");
    let text = (await readFile(file, "utf8")).replace("name: variables", "name: dbi-variables-it");
    let warehouseName = warehouse;
    // A lookup finds a warehouse by name. Given an ID, ask for its name once.
    if (warehouse && /^[0-9a-f]{16}$/.test(warehouse)) {
      const { stdout } = await promisify(execFile)(cli, ["warehouses", "get", warehouse, "--profile", profile, "--output", "json"], { timeout: 60_000 });
      warehouseName = (JSON.parse(stdout) as { name: string }).name;
      expectedWarehouseId = warehouse;
    }
    text = warehouseName
      ? text.replace("warehouse: shared-warehouse", `warehouse: ${JSON.stringify(warehouseName)}`)
      : text.replace(/  warehouse_id:\n    lookup:\n      warehouse: shared-warehouse\n/, "  warehouse_id:\n    default: no-warehouse-given\n");
    await writeFile(file, text);
  } else {
    const empty = path.join(root, "empty.databrickscfg");
    await writeFile(empty, "");
    setEnv("DATABRICKS_HOST", await startFakeWorkspace());
    setEnv("DATABRICKS_TOKEN", "fake-token");
    setEnv("DATABRICKS_CONFIG_FILE", empty);
    setEnv("DATABRICKS_CONFIG_PROFILE", undefined);
  }
  setEnv("BUNDLE_VAR_catalog", undefined);
}, 60_000);

afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  if (server) console.log(`[variables-cli] fake workspace answered ${requests} requests`);
});

type Task = { task_key: string; notebook_task?: { base_parameters?: Record<string, string> }; sql_task?: { warehouse_id?: string } };

/** Each task setting that uses a variable, as written and as the CLI resolved it. */
function settings(bundle: ParsedBundleConfig): Map<string, string> {
  const tasks = ((bundle.resources?.jobs?.variables_job as { tasks?: Task[] } | undefined)?.tasks ?? []);
  return new Map(
    tasks.flatMap((task) => [
      ...Object.entries(task.notebook_task?.base_parameters ?? {}).map(([key, value]) => [`${task.task_key}.${key}`, String(value)] as const),
      ...(task.sql_task?.warehouse_id ? [[`${task.task_key}.warehouse_id`, task.sql_task.warehouse_id] as const] : []),
    ]),
  );
}

/** The extension's resolution bundle for a picked target (extension.ts inspectBundleAtTarget). */
function resolutionBundle(preview: ParsedBundleConfig, target: ParsedBundleConfig): ParsedBundleConfig {
  return {
    bundle: target.bundle,
    variables: { ...(preview.variables ?? {}), ...(target.variables ?? {}) },
    targets: target.targets ?? preview.targets,
  } as ParsedBundleConfig;
}

async function validated(fixture: string, target?: string) {
  const result = await validateBundle(path.join(root, fixture), target, cli, target ? profile : undefined);
  if (!result.ok) throw new Error(`${fixture} ${target ?? "preview"}: ${result.error.error} ${result.error.details ?? ""}`);
  return result.data;
}

describe(`variables: the inspector shows the value the CLI deploys (${cli}, ${mode})`, () => {
  test.each(TARGETS)("%s", async (target) => {
    const preview = await validated("variables");
    const resolved = await validated("variables", target);
    const written = settings(preview);
    const deployed = settings(resolved);
    const bundle = resolutionBundle(preview, resolved);
    const differences = [...written].flatMap(([setting, expression]) => {
      if (!expression.includes("${var.")) return [];
      const shown = resolveExpressionForTarget(expression, bundle, target).value;
      return shown === deployed.get(setting) ? [] : [`${setting}: shows ${shown}, CLI deploys ${deployed.get(setting)}`];
    });
    expect(differences).toEqual([]);
    expect(written.size).toBeGreaterThan(10);
  });

  // #230: the CLI gives a target its values, not the ${var...} they came from.
  test.each(TARGETS)("%s: each task lists the variables it uses, as in the preview", async (target) => {
    const dir = path.join(root, "variables");
    const previewGraph = await extractBundleGraph(await validated("variables"), dir);
    const targetGraph = await extractBundleGraph(await validated("variables", target), dir);
    const references = (graph: BundleGraph) =>
      Object.fromEntries(
        graph.nodes
          .filter((node) => node.taskData)
          .map((node) => [node.id, node.taskData!.variableReferences.map((ref) => ref.variableName).sort()]),
      );
    const uses = (graph: BundleGraph) =>
      graph.edges.filter((edge) => edge.kind === "uses" && edge.target.startsWith("var:")).map((edge) => edge.id).sort();

    expect(Object.values(references(targetGraph)).flat()).toEqual([]);
    const shown = withPreviewVariableReferences(targetGraph, previewGraph);
    expect(references(shown)).toEqual(references(previewGraph));
    expect(Object.values(references(shown)).flat().length).toBeGreaterThan(10);
    expect(uses(shown)).toEqual(uses(previewGraph));
  });

  test("the lookup resolves to the warehouse's ID", async () => {
    if (!expectedWarehouseId) {
      console.log("[variables-cli] lookup skipped: set INSPECTOR_TEST_WAREHOUSE to a warehouse ID");
      return;
    }
    const preview = await validated("variables");
    const resolved = await validated("variables", "dev");
    expect(settings(resolved).get("lookup_value.warehouse_id")).toBe(expectedWarehouseId);
    expect(resolveExpressionForTarget("${var.warehouse_id}", resolutionBundle(preview, resolved), "dev").value).toBe(expectedWarehouseId);
  });

  test("a BUNDLE_VAR_ environment variable beats the target's override, and says it comes from outside the files", async () => {
    const preview = await validated("variables");
    process.env.BUNDLE_VAR_catalog = "catalog_from_env";
    let resolved: ParsedBundleConfig;
    try {
      resolved = await validated("variables", "staging");
    } finally {
      delete process.env.BUNDLE_VAR_catalog;
    }
    expect(settings(resolved).get("whole_values.catalog")).toBe("catalog_from_env");
    expect(resolveVariableForTarget(resolutionBundle(preview, resolved), "catalog", "staging")).toMatchObject({
      value: "catalog_from_env",
      source: "outside_files",
    });
  });

  test("variable-overrides.json beats the target's override, and says it comes from outside the files", async () => {
    const preview = await validated("variables");
    const dir = path.join(root, "variables", ".databricks", "bundle", "qa");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "variable-overrides.json"), JSON.stringify({ catalog: "catalog_from_file" }));
    try {
      const resolved = await validated("variables", "qa");
      expect(settings(resolved).get("whole_values.catalog")).toBe("catalog_from_file");
      expect(resolveVariableForTarget(resolutionBundle(preview, resolved), "catalog", "qa")).toMatchObject({
        value: "catalog_from_file",
        source: "outside_files",
      });
    } finally {
      await rm(path.join(root, "variables", ".databricks"), { recursive: true, force: true });
    }
  });

  test("the mistakes fixture fails its target, as the inspector's preview warns", async () => {
    const result = await validateBundle(path.join(root, "variable-mistakes"), "dev", cli, profile);
    // With JSON on stdout the CLI's errors come back as issues, as the Problems panel shows them.
    const errors = result.ok
      ? (result.issues ?? []).flatMap((issue) => (issue.diagnostics ?? []).filter((d) => d.severity === "error").map((d) => d.message))
      : [`${result.error.error} ${result.error.details ?? ""}`];
    expect(errors.join("\n")).toMatch(/required variable needs_value|reference does not exist|cycle detected/);
  });
});
