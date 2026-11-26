// Unit tests that build a bundle config by hand and cast it to ParsedBundleConfig can give
// the inspector a shape the CLI never produces, or miss one it does: the CLI reshapes YAML
// before the inspector sees it (#408, #674). New tests should read recorded CLI output
// (a fixture's validated-bundle.json, see npm run fixtures:update:validated-bundle). This
// counts the casts that remain and only lets the number go down.
import { describe, expect, test } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The most casts allowed. Lower it when you remove some; the test fails until you do, so the
 * number never creeps back up.
 */
const CEILING = 109;

const UNIT_TESTS = path.resolve(__dirname, "..");
const CAST = /\bas\s+(?:unknown\s+as\s+)?ParsedBundleConfig\b/g;
// A cast on a line that reads a file with JSON.parse is recorded CLI output, not hand-built.
const READS_RECORDING = /JSON\.parse\(\s*(?:await\s+)?read/;

function testFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return entry.name.endsWith(".ts") && full !== __filename ? [full] : [];
  });
}

function handBuiltCasts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of testFiles(UNIT_TESTS)) {
    const casts = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => !READS_RECORDING.test(line))
      .reduce((sum, line) => sum + (line.match(CAST)?.length ?? 0), 0);
    if (casts > 0) counts.set(path.relative(UNIT_TESTS, file).replace(/\\/g, "/"), casts);
  }
  return counts;
}

describe("hand-built bundle configs in unit tests", () => {
  test("only go down", () => {
    const counts = handBuiltCasts();
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const byFile = [...counts].sort((a, b) => b[1] - a[1]).map(([file, n]) => `${n}  ${file}`).join("\n");
    if (total > CEILING) {
      throw new Error(
        `${total} hand-built ParsedBundleConfig casts, more than the ${CEILING} allowed. ` +
          `Read a fixture's recorded validated-bundle.json instead of building the config by hand.\n${byFile}`,
      );
    }
    if (total < CEILING) {
      throw new Error(`${total} hand-built ParsedBundleConfig casts, fewer than ${CEILING}: lower CEILING in this file to ${total}.`);
    }
    expect(total).toBe(CEILING);
  });

  test("recorded fixtures read with JSON.parse are not counted", () => {
    expect(READS_RECORDING.test('JSON.parse(readFileSync(path.join(ROOT, "validated-bundle.json"), "utf8")) as ParsedBundleConfig;')).toBe(true);
    expect(READS_RECORDING.test("return JSON.parse(await readFixtureBundleContent(fixtureRoot)) as ParsedBundleConfig;")).toBe(true);
    expect(READS_RECORDING.test('const c = JSON.parse(\'{"bundle": {}}\') as ParsedBundleConfig;')).toBe(false);
    expect("} as unknown as ParsedBundleConfig);".match(CAST)).toHaveLength(1);
    expect("const x = y as ParsedBundleConfigs;".match(CAST)).toBeNull();
  });
});
