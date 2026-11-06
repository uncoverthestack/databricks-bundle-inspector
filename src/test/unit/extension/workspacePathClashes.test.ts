import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues, workspacePathClashIssues } from "../../../bundle/issues.js";
import { filesUnder } from "../../../bundle/pathSuggestions.js";
import { createSyncFilter } from "../../../bundle/syncRules.js";
import { findWorkspacePathClashes } from "../../../bundle/workspacePathClashes.js";

const PY = "# Databricks notebook source\nx = 1\n";
const SQL = "-- Databricks notebook source\nSELECT 1\n";
const IPYNB = JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 });

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "workspace-path-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
}

function clashes(sync?: ParsedBundleConfig["sync"], rule: "exact" | "contains" = "contains") {
  const uploaded = createSyncFilter(root, sync);
  return findWorkspacePathClashes(root, filesUnder(root).files, uploaded, rule);
}

// Each case was deployed as a bundle of its own (Databricks CLI v1.24.0, 2026-11-06).
describe("files that deploy to the same workspace path", () => {
  test.each([
    ["two notebooks, .py and .sql", { "src/dup.py": PY, "src/dup.sql": SQL }, ["src/dup.py", "src/dup.sql"]],
    ["two notebooks, .py and .ipynb", { "dup.py": PY, "dup.ipynb": IPYNB }, ["dup.ipynb", "dup.py"]],
    ["a notebook and a plain file with no extension", { "foo.py": PY, foo: "plain" }, ["foo", "foo.py"]],
    ["an upper-case extension", { "dup.PY": PY, "dup.sql": SQL }, ["dup.PY", "dup.sql"]],
  ])("fails on deploy: %s", (_name, files, expected) => {
    write(files);
    const workspacePath = expected[0]!.replace(/\.[^./]+$/, "");
    expect(clashes()).toEqual([{ kind: "files", workspacePath, files: expected }]);
  });

  test("fails on deploy: a notebook next to a folder of the same name", () => {
    write({ "src/foo.py": PY, "src/foo/data.txt": "x" });
    expect(clashes()).toEqual([{ kind: "folder", workspacePath: "src/foo", notebook: "src/foo.py" }]);
  });

  test.each([
    ["one file is gitignored", { "dup.py": PY, "dup.sql": SQL, ".gitignore": "dup.sql\n" }],
    ["the names differ in case", { "dup.py": PY, "Dup.sql": SQL }],
    ["a plain .py without the header next to a notebook .sql", { "dup.py": "import os\n", "dup.sql": SQL }],
  ])("deploys: %s", (_name, files) => {
    write(files);
    expect(clashes()).toEqual([]);
  });
});

describe("edge cases from the CLI's rule", () => {
  test("sync.exclude leaves a file out, and sync.include brings a gitignored one back", () => {
    write({ "dup.py": PY, "dup.sql": SQL, ".gitignore": "dup.sql\n" });
    expect(clashes({ include: ["dup.sql"] })).toHaveLength(1);
    expect(clashes({ include: ["dup.sql"], exclude: ["dup.sql"] })).toEqual([]);
  });

  test("a folder whose files are all left out isn't uploaded, so it doesn't clash", () => {
    write({ "foo.py": PY, "foo/cache.bin": "x", ".gitignore": "foo/\n" });
    expect(clashes()).toEqual([]);
  });

  test("a folder of a folder still clashes", () => {
    write({ "a/b.py": PY, "a/b/c/d.txt": "x" });
    expect(clashes()).toEqual([{ kind: "folder", workspacePath: "a/b", notebook: "a/b.py" }]);
  });

  test("three notebooks with one name are one finding", () => {
    write({ "x.py": PY, "x.sql": SQL, "x.ipynb": IPYNB });
    expect(clashes()).toEqual([{ kind: "files", workspacePath: "x", files: ["x.ipynb", "x.py", "x.sql"] }]);
  });

  test("a file keeps its full name when it isn't a notebook: dup.py.py lands on a plain dup.py", () => {
    write({ "dup.py.py": PY, "dup.py": "import os\n" });
    expect(clashes()).toEqual([{ kind: "files", workspacePath: "dup.py", files: ["dup.py", "dup.py.py"] }]);
    write({ "dup.py": PY });
    expect(clashes()).toEqual([]);
  });

  test("a .designer.ipynb file keeps its full name", () => {
    write({ "flow.designer.ipynb": IPYNB, "flow.designer.py": PY });
    expect(clashes()).toEqual([]);
  });

  // The CLI's walk skips anything that isn't a regular file or folder ("Skip non-regular
  // files (e.g. symlinks)", libs/fileset/fileset.go, v1.24.0). Deployed on a workspace
  // 2026-11-06: notebook dup.py with a symlinked dup.sql, and notebook foo.py with a
  // symlinked folder foo, both deploy. If the CLI starts uploading symlinks, this fails.
  // Windows needs extra rights to create symlinks, so it skips this.
  (process.platform === "win32" ? test.skip : test)("a symlinked file or folder isn't uploaded, so it doesn't clash", () => {
    write({ "src/dup.py": PY, "src/foo.py": PY, "shared/x.sql": SQL, "shared/y.txt": "y" });
    symlinkSync("../shared/x.sql", path.join(root, "src/dup.sql"));
    symlinkSync("../shared", path.join(root, "src/foo"), "dir");
    expect(clashes()).toEqual([]);
  });

  test("the same names in different folders don't clash", () => {
    write({ "a/load.py": PY, "b/load.sql": SQL });
    expect(clashes()).toEqual([]);
  });

  test("the header rule follows the CLI version: a header after a byte order mark", () => {
    write({ "dup.py": `﻿${PY}`, "dup.sql": SQL });
    expect(clashes(undefined, "contains")).toHaveLength(1);
    expect(clashes(undefined, "exact")).toEqual([]);
  });
});

describe("the finding", () => {
  test("names the files and the workspace path, at the first file", () => {
    write({ "src/dup.py": PY, "src/dup.sql": SQL, "src/foo.py": PY, "src/foo/x.txt": "x" });
    const issues = workspacePathClashIssues(root, filesUnder(root).files, () => true);
    expect(issues.map(({ kind, severity, title, file, line }) => ({ kind, severity, title, file, line }))).toEqual([
      {
        kind: "same_workspace_path",
        severity: "error",
        title: '"src/dup.py" and "src/dup.sql" both deploy to "src/dup", so bundle deploy may fail.',
        file: path.join(root, "src/dup.py"),
        line: 1,
      },
      {
        kind: "same_workspace_path",
        severity: "error",
        title: 'Notebook "src/foo.py" deploys to "src/foo", which is also a folder, so bundle deploy may fail.',
        file: path.join(root, "src/foo.py"),
        line: 1,
      },
    ]);
  });

  test("comes through the full issue list, with or without a target, and not with sync.paths", async () => {
    write({ "src/dup.py": PY, "src/dup.sql": SQL });
    const config = { bundle: { name: "clash" }, resources: {} } as unknown as ParsedBundleConfig;
    const graph = await extractBundleGraph(config, root);
    const kinds = (bundle: ParsedBundleConfig, target?: string) =>
      buildInspectorIssues(graph, bundle, [], root, target).filter((issue) => issue.kind === "same_workspace_path");
    expect(kinds(config)).toHaveLength(1);
    expect(kinds(config, "dev")).toHaveLength(1);
    expect(kinds({ ...config, sync: { paths: [".."] } } as ParsedBundleConfig)).toEqual([]);
  });
});

describe("stress", () => {
  // Only files that share a name are opened, so only those 1,000 are written to disk; the
  // other 19,000 are names, as the folder walk would list them.
  test("20,000 files with 500 shared names: only real clashes, quickly", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 500; i++) {
      files[`d${i % 50}/n${i}.py`] = PY;
      // Every other pair is a plain .sql without the header, which deploys fine.
      files[`d${i % 50}/n${i}.sql`] = i % 2 === 0 ? SQL : "SELECT 1\n";
    }
    write(files);
    const names = Object.keys(files).map((name) => path.join(root, name));
    // Unshared names, including notebook extensions, which must not be opened.
    for (let i = 0; names.length < 20_000; i++) {
      names.push(path.join(root, "data", i % 2 === 0 ? `part-${i}.csv` : `job-${i}.py`));
    }
    const started = Date.now();
    const found = findWorkspacePathClashes(root, names, createSyncFilter(root), "contains");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(found).toHaveLength(250);
    expect(found.every((clash) => clash.kind === "files" && clash.files.length === 2)).toBe(true);
  });
});
