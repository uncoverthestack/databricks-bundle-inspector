// Fixtures named validated-bundle.json hold real `bundle validate --output json` output,
// recorded with `npm run fixtures:update:validated-bundle`. Hand-written output can take a
// shape the CLI never produces (#408), so each one must say which CLI recorded it, and
// must not have been edited since: the recorder stores a checksum of what it wrote.
import { describe, expect, test } from "@jest/globals";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "../../../../scripts/canonical-json.cjs";

const FIXTURES = path.resolve(__dirname, "../../fixtures");

const recorded = readdirSync(FIXTURES).filter((name) => existsSync(path.join(FIXTURES, name, "validated-bundle.json")));

describe("recorded CLI output fixtures", () => {
  test("the fixtures are found", () => {
    expect(recorded.length).toBeGreaterThanOrEqual(9);
  });

  test.each(recorded)("%s was recorded by a Databricks CLI and not edited since", (name) => {
    const metaPath = path.join(FIXTURES, name, "validated-bundle.meta.json");
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { databricksCliVersion?: string; validatedBundleCanonicalSha256?: string };
    expect(meta.databricksCliVersion).toMatch(/^v?\d+\.\d+\.\d+/);
    const bundle: unknown = JSON.parse(readFileSync(path.join(FIXTURES, name, "validated-bundle.json"), "utf8"));
    const checksum = canonicalJsonSha256(bundle);
    // A mismatch means the file was edited by hand: re-record it instead with
    // npm run fixtures:update:validated-bundle -- --fixture src/test/fixtures/<name>
    expect(checksum).toBe(meta.validatedBundleCanonicalSha256);
  });
});
