import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import { buildOutputs, isLocalDependency, localLibrary, mayBeBuilt, wheelBuildHint, withoutWheelExtras } from "../../../bundle/localLibraries.js";

// Rules from the CLI's bundle/libraries (v1.27.0) and live deploys on 2026-11-24 (#482, #525).

describe("isLocalDependency, as the CLI's IsLibraryLocal", () => {
  test.each([
    "./dist/a-0.1-py3-none-any.whl",
    "../dist/*.whl",
    "dist/a-0.1-py3-none-any.whl",
    ".",
  ])("%s is a local file", (dependency) => {
    expect(isLocalDependency(dependency)).toBe(true);
  });

  test.each([
    "six",
    "six==1.16",
    "numpy>=1.0,<2",
    "requests[security]==2.31.0",
    "-r ../requirements.txt",
    "-e ../pkg",
    "--index-url https://example.org/simple",
    "pkg @ https://example.org/pkg.whl",
    "/Volumes/main/libs/a.whl",
    "/Workspace/Shared/a.whl",
    "dbfs:/libs/a.whl",
    "s3://bucket/a.whl",
    "",
  ])("%s is not", (dependency) => {
    expect(isLocalDependency(dependency)).toBe(false);
  });

  test("wheel extras are left out before matching", () => {
    expect(withoutWheelExtras("./dist/a-0.1-py3-none-any.whl[extra,other]")).toBe("./dist/a-0.1-py3-none-any.whl");
    expect(withoutWheelExtras("./dist/[x]/a.whl")).toBe("./dist/[x]/a.whl");
  });
});

describe("localLibrary", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "dbi-local-libs-"));
    mkdirSync(path.join(root, "dist"));
    mkdirSync(path.join(root, "resources"));
    writeFileSync(path.join(root, "dist", "a-0.1-py3-none-any.whl"), "x");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test.each([
    ["../dist/*.whl", true],
    ["../dist/a-*.whl", true],
    ["../dist/b-*.whl", false],
    ["./dist/*.whl", false],
    ["../dist/a-0.1-py3-none-any.whl", true],
    ["../dist/missing.whl", false],
    // Go's "**" is "*": one folder level, not every level.
    ["../**/*.whl", true],
  ])("%s from resources/ exists: %s", (raw, exists) => {
    const result = localLibrary(raw, path.join(root, "resources"));
    expect(result.exists).toBe(exists);
    expect(result.resolvedPath).toBe(path.resolve(root, "resources", raw));
  });
});

describe("buildOutputs and mayBeBuilt", () => {
  // Absolute on every OS: on Windows `\\b` has no drive, and path.resolve would add one.
  const root = path.resolve(path.sep, "b");
  const definedIn = () => root;
  const built = (config: Parameters<typeof buildOutputs>[0], file: string) =>
    mayBeBuilt(path.join(root, file), buildOutputs(config, root, definedIn));

  test("a whl artifact without files builds into <path>/dist", () => {
    const config = { artifacts: { a: { type: "whl", path: "./pkg" } } };
    expect(built(config, "pkg/dist/*.whl")).toBe(true);
    expect(built(config, "dist/*.whl")).toBe(false);
  });

  test("a whl artifact without a path builds into the bundle root's dist, wherever it is defined", () => {
    const fromResources = (config: Parameters<typeof buildOutputs>[0], file: string) =>
      mayBeBuilt(path.join(root, file), buildOutputs(config, root, () => path.join(root, "resources")));
    expect(fromResources({ artifacts: { a: { type: "whl" } } }, "dist/a.whl")).toBe(true);
    expect(fromResources({ artifacts: { a: { type: "whl" } } }, "resources/dist/a.whl")).toBe(false);
    // A path that is set is read from the defining file's folder.
    expect(fromResources({ artifacts: { a: { type: "whl", path: "../pkg" } } }, "pkg/dist/a.whl")).toBe(true);
  });

  test("files without a build are already there: nothing is built (acceptance bundle glob_exact_whl)", () => {
    const config = { artifacts: { p: { type: "whl", files: [{ source: "prebuilt/a-0.0.1-py3-none-any.whl" }] } } };
    expect(built(config, "prebuilt/a-0.0.1-py3-none-any.whl")).toBe(false);
  });

  test("folders are compared ignoring letter case on Windows and macOS, as their disks do", () => {
    const config = { artifacts: { a: { type: "whl" } } };
    const upper = mayBeBuilt(path.join(root.toUpperCase(), "DIST", "a.whl"), buildOutputs(config, root, definedIn));
    expect(upper).toBe(process.platform === "win32" || process.platform === "darwin");
  });

  test("a tgz the CLI builds from include names its output in files", () => {
    const config = { artifacts: { t: { type: "tgz", include: ["src/**"], files: [{ source: "out/app.tgz" }] } } };
    expect(built(config, "out/app.tgz")).toBe(true);
  });

  test("an artifact's files name its output folders; a real target gives them absolute", () => {
    const config = { artifacts: { j: { build: "mvn package", files: [{ source: path.join(root, "target", "*.jar") }] } } };
    expect(built(config, "target/app.jar")).toBe(true);
    expect(built(config, "resources/target/app.jar")).toBe(false);
  });

  test("an artifact with a build and no files could write anywhere", () => {
    expect(built({ artifacts: { a: { build: "make" } } }, "anything/x.jar")).toBe(true);
  });

  test("experimental build hooks could write anywhere; top-level scripts never run on deploy", () => {
    expect(built({ experimental: { scripts: { prebuild: "make wheel" } } }, "dist/x.whl")).toBe(true);
    expect(built({ experimental: { scripts: { postbuild: "make wheel" } } }, "dist/x.whl")).toBe(true);
    expect(built({ experimental: { scripts: { predeploy: "make wheel" } } }, "dist/x.whl")).toBe(false);
    expect(built({ scripts: { prebuild: { content: "make wheel" } } } as never, "dist/x.whl")).toBe(false);
  });

  test("without artifacts, a setup.py in the bundle root builds into dist", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dbi-setup-py-"));
    try {
      expect(mayBeBuilt(path.join(dir, "dist", "a.whl"), buildOutputs({}, dir, () => dir))).toBe(false);
      writeFileSync(path.join(dir, "setup.py"), "");
      expect(mayBeBuilt(path.join(dir, "dist", "a.whl"), buildOutputs({}, dir, () => dir))).toBe(true);
      // An artifacts block turns the auto-detection off.
      expect(mayBeBuilt(path.join(dir, "dist", "a.whl"), buildOutputs({ artifacts: {} }, dir, () => dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("task library globs through the graph (#525)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "dbi-lib-globs-"));
    mkdirSync(path.join(root, "resources"));
    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "dist", "a-0.1-py3-none-any.whl"), "x");
    writeFileSync(path.join(root, "nb.py"), "# Databricks notebook source\nprint(1)\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const details = async (libraries: unknown[], extra: Record<string, unknown> = {}) => {
    const task = { task_key: "t", notebook_task: { notebook_path: "../nb.py" }, libraries };
    const loop = { task_key: "loop", for_each_task: { inputs: "[1]", task: { ...task, task_key: "inner" } } };
    writeFileSync(path.join(root, "resources", "job.yml"), "resources:\n  jobs:\n    j:\n      tasks: []\n");
    const config = {
      bundle: { name: "globs" },
      include: ["resources/job.yml"],
      resources: { jobs: { j: { tasks: [task, loop] } } },
      ...extra,
    } as unknown as ParsedBundleConfig;
    const graph = await extractBundleGraph(config, root);
    return buildInspectorIssues(graph, config, [], root)
      .filter((issue) => issue.kind === "missing_library")
      .map((issue) => `${issue.taskName}: ${issue.detail}`);
  };

  test("a glob that matches a file is no finding, for a task and a for_each inner task", async () => {
    expect(await details([{ whl: "../dist/*.whl" }])).toEqual([]);
  });

  test("a glob no file matches is, for both", async () => {
    expect(await details([{ whl: "../dist/b-*.whl" }])).toEqual([
      "t: ../dist/b-*.whl (no file matches)",
      "loop: ../dist/b-*.whl (no file matches)",
    ]);
  });

  test("a wheel an artifact builds at deploy is no finding before it is built", async () => {
    const artifacts = { artifacts: { w: { type: "whl", path: "./pkg" } } };
    expect(await details([{ whl: "../pkg/dist/*.whl" }, { whl: "../pkg/dist/x-1-py3-none-any.whl" }], artifacts)).toEqual([]);
    // Read from resources/, so nothing is built where it points.
    expect(await details([{ whl: "./pkg/dist/*.whl" }], artifacts)).toEqual([
      "t: ./pkg/dist/*.whl (no file matches)",
      "loop: ./pkg/dist/*.whl (no file matches)",
    ]);
  });
});

describe("a pyproject.toml project with no artifacts (public bundles, 2026-11-26)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "dbi-pyproject-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const project = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(root, "p-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    return dir;
  };

  test("a missing wheel says why deploy doesn't build it", () => {
    const outputs = buildOutputs({}, project({ "pyproject.toml": "[project]\nname='x'\n" }), () => root);
    expect(outputs.pyprojectNotBuilt).toBe(true);
    expect(wheelBuildHint("../dist/*.whl", outputs)).toContain("with build: uv build --wheel");
    expect(wheelBuildHint("../dist/app-0.1-py3-none-any.whl[extra]", outputs)).not.toBe("");
  });

  test("controls: a setup.py, an artifacts entry, a build hook, or a file that isn't a wheel get no hint", () => {
    expect(buildOutputs({}, project({ "pyproject.toml": "", "setup.py": "" }), () => root).pyprojectNotBuilt).toBeUndefined();
    expect(buildOutputs({ artifacts: { a: { type: "whl" } } }, project({ "pyproject.toml": "" }), () => root).pyprojectNotBuilt).toBeUndefined();
    expect(
      buildOutputs({ experimental: { scripts: { prebuild: "uv build" } } }, project({ "pyproject.toml": "" }), () => root).pyprojectNotBuilt,
    ).toBeUndefined();
    expect(buildOutputs({}, project({}), () => root).pyprojectNotBuilt).toBeUndefined();
    const outputs = buildOutputs({}, project({ "pyproject.toml": "" }), () => root);
    expect(wheelBuildHint("../lib/app.jar", outputs)).toBe("");
  });
});
