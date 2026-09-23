import { describe, expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
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
 */

// Resource types in the schema that the inspector does not model yet. They still
// render as generic nodes. Remove an entry once it is added to MODELLED_RESOURCE_GROUPS.
const KNOWN_RESOURCE_GAPS = [
  "cluster_policies",
  "genie_spaces",
  "instance_pools",
  "job_runs",
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

  test("every resource type in the schema is modelled or a known gap", async () => {
    const schema = await bundleSchema();
    const resources = schema.properties?.resources;
    if (!resources) throw new Error("bundle schema has no resources property");
    const groups = propertyNames(schema, resources);
    const covered = new Set<string>([...MODELLED_RESOURCE_GROUPS, ...KNOWN_RESOURCE_GAPS]);

    expect(groups.length).toBeGreaterThan(0);
    expect(groups.filter((group) => !covered.has(group))).toEqual([]);
  });
});
