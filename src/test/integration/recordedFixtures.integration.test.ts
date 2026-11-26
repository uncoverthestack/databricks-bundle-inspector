import { describe, expect, test } from "@jest/globals";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { validateBundle } from "../../bundle/validateBundle.js";

/**
 * Validates every fixture that holds recorded CLI output (validated-bundle.json) with the
 * installed CLI, the way the inspector does, and fails when the output differs from the
 * recording. Unit tests read these files in place of the CLI, so they must stay what the
 * CLI produces. CI runs this on the latest CLI, weekly too, so a CLI release that changes
 * its output shows up here. To accept a change, re-record the fixture:
 * npm run fixtures:update:validated-bundle -- --fixture src/test/fixtures/<name>
 */

const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
const FIXTURES = path.resolve(__dirname, "../fixtures");
const recorded = readdirSync(FIXTURES).filter((name) => existsSync(path.join(FIXTURES, name, "validated-bundle.json")));

/** Paths whose values differ between two JSON values, such as `resources.jobs.a.name`. */
function differences(expected: unknown, actual: unknown, at = ""): string[] {
  if (expected && actual && typeof expected === "object" && typeof actual === "object" && Array.isArray(expected) === Array.isArray(actual)) {
    const a = expected as Record<string, unknown>;
    const b = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((key) => {
      const child = Array.isArray(expected) ? `${at}[${key}]` : at ? `${at}.${key}` : key;
      if (!(key in b)) return [`${child}: recorded, no longer in the output`];
      if (!(key in a)) return [`${child}: new in the output`];
      return differences(a[key], b[key], child);
    });
  }
  return JSON.stringify(expected) === JSON.stringify(actual) ? [] : [`${at}: ${JSON.stringify(expected)} -> ${JSON.stringify(actual)}`];
}

describe("recorded fixtures match the installed CLI", () => {
  test.each(recorded)("%s", async (name) => {
    const dir = path.join(FIXTURES, name);
    const meta = JSON.parse(readFileSync(path.join(dir, "validated-bundle.meta.json"), "utf8")) as { bundleTarget?: string };
    const recording: unknown = JSON.parse(readFileSync(path.join(dir, "validated-bundle.json"), "utf8"));
    const result = await validateBundle(dir, meta.bundleTarget, cli);
    if (!result.ok) throw new Error(`bundle validate failed for ${name}: ${JSON.stringify(result.error)}`);
    expect(differences(recording, result.data)).toEqual([]);
  });
});
