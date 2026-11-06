import { describe, expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { MODELLED_RESOURCE_GROUPS } from "../../bundle/graph/bundleGraph.js";
import { TASK_PAYLOAD_KEYS } from "../../bundle/resources/task.js";

/**
 * Fails when `databricks bundle schema` contains a job task type or resource
 * type the inspector neither models nor lists as a known gap. That turns a new
 * CLI release adding bundle surface into a failing check instead of silent drift.
 *
 * Types missing from an older CLI's schema are fine: the inspector may support
 * types newer than the CLI a user runs.
 *
 * It also fails when a resource group is in neither table of
 * docs/supported-resources.md, so the "Not supported yet" list stays complete.
 */

// Resource types in the schema that the inspector does not model yet. They still
// render as generic nodes. Remove an entry once it is added to MODELLED_RESOURCE_GROUPS.
const KNOWN_RESOURCE_GAPS = [
  "cluster_policies",
  "data_quality_monitors",
  "features",
  "genie_spaces",
  "instance_pools",
  "job_runs",
  "materialization_sets",
  "mcp_services",
  "model_provider_services",
  "model_services",
  "postgres_catalogs",
  "postgres_databases",
  "postgres_roles",
  "postgres_snapshot_schedules",
  "postgres_synced_tables",
  "secrets",
  "vector_search_endpoints",
  "vector_search_indexes",
];

const execFileAsync = promisify(execFile);

const NOT_SUPPORTED_HEADING = "## Not supported yet";

/**
 * The resource groups named in the first cell of each table row in
 * docs/supported-resources.md, split into the supported table (before the
 * "Not supported yet" heading) and the not supported list (after it).
 */
function documentedResourceGroups(): { supported: string[]; notSupported: string[] } {
  const doc = readFileSync(path.resolve(__dirname, "../../../docs/supported-resources.md"), "utf8");
  const headingAt = doc.indexOf(NOT_SUPPORTED_HEADING);
  if (headingAt === -1) throw new Error(`docs/supported-resources.md has no "${NOT_SUPPORTED_HEADING}" heading`);
  const groupsIn = (text: string) =>
    text
      .split("\n")
      .filter((line) => line.startsWith("| "))
      .map((line) => /^\| \[?`([a-z_]+)`/.exec(line)?.[1])
      .filter((group): group is string => group !== undefined);
  return { supported: groupsIn(doc.slice(0, headingAt)), notSupported: groupsIn(doc.slice(headingAt)) };
}

async function schemaResourceGroups(): Promise<string[]> {
  const schema = await bundleSchema();
  const resources = schema.properties?.resources;
  if (!resources) throw new Error("bundle schema has no resources property");
  return propertyNames(schema, resources);
}

type JsonSchema = {
  $ref?: string;
  properties?: Record<string, JsonSchema>;
  oneOf?: JsonSchema[];
  $defs?: Record<string, unknown>;
};

function resolve(root: JsonSchema, node: JsonSchema): JsonSchema {
  if (!node.$ref) return node;
  let target: unknown = root;
  for (const part of node.$ref.replace(/^#\//, "").split("/")) {
    target = (target as Record<string, unknown>)[part];
  }
  return target as JsonSchema;
}

function propertyNames(root: JsonSchema, node: JsonSchema): string[] {
  const resolved = resolve(root, node);
  const withProperties =
    resolved.properties !== undefined
      ? resolved
      : resolved.oneOf?.find((option) => option.properties !== undefined);
  return Object.keys(withProperties?.properties ?? {});
}

function findDefinition(root: JsonSchema, suffix: string): JsonSchema {
  const stack: unknown[] = [root.$defs];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, value] of Object.entries(current)) {
      // `slice/...` and `map/...` hold array and map wrappers of the same type.
      if (key === "slice" || key === "map") continue;
      if (key.endsWith(suffix) && value && typeof value === "object") {
        return value as JsonSchema;
      }
      stack.push(value);
    }
  }
  throw new Error(`Definition ending in "${suffix}" not found in bundle schema`);
}

async function bundleSchema(): Promise<JsonSchema> {
  const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
  const { stdout } = await execFileAsync(cli, ["bundle", "schema"], {
    timeout: 30_000,
    maxBuffer: 50 * 1024 * 1024,
  });
  return JSON.parse(stdout) as JsonSchema;
}

describe("bundle schema coverage", () => {
  test("known gaps are not also listed as modelled", () => {
    const modelled = new Set<string>(MODELLED_RESOURCE_GROUPS);
    expect(KNOWN_RESOURCE_GAPS.filter((group) => modelled.has(group))).toEqual([]);
  });

  test("every job task type in the schema is recognised", async () => {
    const schema = await bundleSchema();
    const taskKeys = propertyNames(schema, findDefinition(schema, "jobs.Task")).filter(
      (key) => key.endsWith("_task"),
    );
    const recognised = new Set<string>(TASK_PAYLOAD_KEYS);

    expect(taskKeys.length).toBeGreaterThan(0);
    expect(taskKeys.filter((key) => !recognised.has(key))).toEqual([]);
  });

  test("no resource group is in both tables of docs/supported-resources.md", () => {
    const { supported, notSupported } = documentedResourceGroups();
    expect(supported).toEqual(["jobs", "pipelines", "secret_scopes", "clusters"]);
    expect(notSupported.length).toBeGreaterThan(0);
    expect(notSupported.filter((group) => supported.includes(group))).toEqual([]);
  });

  test("every resource group in the schema is in docs/supported-resources.md", async () => {
    const groups = await schemaResourceGroups();
    const { supported, notSupported } = documentedResourceGroups();
    const documented = new Set<string>([...supported, ...notSupported]);

    expect(groups.length).toBeGreaterThan(0);
    expect(groups.filter((group) => !documented.has(group))).toEqual([]);
  });

  test("every resource type in the schema is modelled or a known gap", async () => {
    const groups = await schemaResourceGroups();
    const covered = new Set<string>([...MODELLED_RESOURCE_GROUPS, ...KNOWN_RESOURCE_GAPS]);

    expect(groups.length).toBeGreaterThan(0);
    expect(groups.filter((group) => !covered.has(group))).toEqual([]);
  });
});
