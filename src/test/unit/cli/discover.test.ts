import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverBundles, displayPath } from "../../../cli/discover.js";
import { runCli } from "../../../cli/main.js";

let dir: string;
const bundle = (...parts: string[]) => {
  const folder = path.join(dir, ...parts.slice(0, -1));
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, parts.at(-1)!), "bundle:\n  name: x\n");
};
const rel = (roots: string[]) => roots.map((root) => displayPath(root, dir));

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "dbi-cli-discover-"));
  bundle("databricks.yml");
  bundle("jobs", "nightly", "databricks.yaml");
  bundle("jobs", "both", "databricks.yml");
  bundle("jobs", "both", "databricks.yaml");
  bundle("node_modules", "pkg", "databricks.yml");
  bundle(".venv", "lib", "databricks.yml");
  bundle("deep", ".databricks", "bundle", "databricks.yml");
  writeFileSync(path.join(dir, "notes.txt"), "x");
  try {
    // A link back up the tree: following it would loop. Windows may refuse links without rights.
    symlinkSync(dir, path.join(dir, "jobs", "loop"), "dir");
  } catch {
    // Without the link the other cases still hold.
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("finding bundles (#348)", () => {
  test("every bundle folder below, closest first, skipping installed and generated folders and links", () => {
    const found = discoverBundles(["."], dir);
    expect(found.ok).toBe(true);
    expect(rel((found as { roots: string[] }).roots)).toEqual([".", "jobs/both", "jobs/nightly"]);
  });

  test("a bundle file or a folder given directly", () => {
    const found = discoverBundles([path.join("jobs", "nightly", "databricks.yaml"), path.join("jobs", "both")], dir);
    expect(rel((found as { roots: string[] }).roots)).toEqual(["jobs/both", "jobs/nightly"]);
  });

  test("a path given twice counts once", () => {
    const found = discoverBundles(["jobs", path.join("jobs", "nightly")], dir);
    expect(rel((found as { roots: string[] }).roots)).toEqual(["jobs/both", "jobs/nightly"]);
  });

  test.each([
    [["missing-folder"], "No such file or folder: missing-folder"],
    [["notes.txt"], "Not a bundle file or a folder: notes.txt"],
    [["node_modules"], "No databricks.yml or databricks.yaml found under: node_modules"],
  ])("wrong usage %j", (paths, message) => {
    const found = discoverBundles(paths, dir);
    expect(found).toEqual({ ok: false, message: expect.stringContaining(message) });
  });

  test("paths in the report are relative, with / on every OS", () => {
    expect(displayPath(path.join(dir, "a", "b.yml"), dir)).toBe("a/b.yml");
    expect(displayPath(dir, dir)).toBe(".");
    expect(displayPath(path.join(path.dirname(dir), "other"), dir)).toBe("../other");
  });
});

describe("error messages", () => {
  test("never print a line a CI log reads as a workflow command", async () => {
    let stderr = "";
    const io = { stdout: () => {}, stderr: (text: string) => (stderr += text), cwd: dir, env: {}, isTty: false };
    const code = await runCli(["check", "missing\n::error::injected", "--format", "github"], io);
    expect(code).toBe(2);
    expect(stderr).toContain("injected");
    expect(stderr.split(/\r?\n/).some((line) => /^\s*::/.test(line))).toBe(false);
  });
});
