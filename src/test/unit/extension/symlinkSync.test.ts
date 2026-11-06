import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import { createSyncExclusion } from "../../../bundle/syncRules.js";

// #372: the CLI's walk skips symbolic links ("Skip non-regular files (e.g. symlinks)",
// libs/fileset/fileset.go, v1.24.0). Checked on a workspace 2026-11-06: a task on a
// symlinked notebook, and a %run of it, deploy and then fail when the job runs.
// Windows needs extra rights to create symlinks, so it skips these.
const PY = "# Databricks notebook source\nx = 1\n";
let base: string;
let root: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "symlink-sync-"));
  root = path.join(base, "bundle");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(base, "outside"), { recursive: true });
  mkdirSync(path.join(root, "shared"), { recursive: true });
  writeFileSync(path.join(root, "src", "real_nb.py"), PY);
  writeFileSync(path.join(root, "shared", "helper.py"), PY);
  writeFileSync(path.join(base, "outside", "other.py"), PY);
  symlinkSync("real_nb.py", path.join(root, "src", "linked_nb.py"));
  symlinkSync(path.join(base, "outside", "other.py"), path.join(root, "src", "outside_nb.py"));
  symlinkSync("../shared", path.join(root, "src", "linked_dir"), "dir");
  symlinkSync("missing.py", path.join(root, "src", "dangling.py"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

(process.platform === "win32" ? describe.skip : describe)("symbolic links are not deployed", () => {
  test("a linked file, a file in a linked folder, and a dangling link are skipped", () => {
    const exclusion = createSyncExclusion(root);
    const at = (relative: string) => path.join(root, relative);
    expect(exclusion(at("src/linked_nb.py"))).toEqual({ rule: "symlink", link: at("src/linked_nb.py"), folder: false });
    expect(exclusion(at("src/outside_nb.py"))).toEqual({ rule: "symlink", link: at("src/outside_nb.py"), folder: false });
    expect(exclusion(at("src/linked_dir/helper.py"))).toEqual({ rule: "symlink", link: at("src/linked_dir"), folder: true });
    expect(exclusion(at("src/dangling.py"))).toEqual({ rule: "symlink", link: at("src/dangling.py"), folder: false });
  });

  test("the real files are deployed, and sync.include can't bring a link back", () => {
    const exclusion = createSyncExclusion(root, { include: ["src/linked_nb.py", "src/linked_dir/**"] });
    expect(exclusion(path.join(root, "src/real_nb.py"))).toBeUndefined();
    expect(exclusion(path.join(root, "shared/helper.py"))).toBeUndefined();
    expect(exclusion(path.join(root, "src/linked_nb.py"))?.rule).toBe("symlink");
    expect(exclusion(path.join(root, "src/linked_dir/helper.py"))?.rule).toBe("symlink");
  });

  test("a link above the bundle root, or the root itself, doesn't count: the CLI starts there", () => {
    const linkedRoot = path.join(base, "linked-bundle");
    symlinkSync(root, linkedRoot, "dir");
    expect(createSyncExclusion(linkedRoot)(path.join(linkedRoot, "src/real_nb.py"))).toBeUndefined();
    // macOS temp folders sit under a link (/var -> /private/var); the real path is the same.
    const real = realpathSync(root);
    expect(createSyncExclusion(real)(path.join(real, "src/real_nb.py"))).toBeUndefined();
  });

  test("a task on a linked notebook, and a %run of one, get excluded_from_sync", async () => {
    writeFileSync(path.join(root, "src", "caller.py"), `${PY}\n# COMMAND ----------\n\n# MAGIC %run ./linked_nb\n`);
    const config = {
      bundle: { name: "links" },
      resources: {
        jobs: {
          links: {
            tasks: [
              { task_key: "task_on_link", notebook_task: { notebook_path: "./src/linked_nb.py" } },
              { task_key: "task_in_linked_dir", notebook_task: { notebook_path: "./src/linked_dir/helper.py" } },
              { task_key: "run_link", notebook_task: { notebook_path: "./src/caller.py" } },
              { task_key: "real", notebook_task: { notebook_path: "./src/real_nb.py" } },
            ],
          },
        },
      },
    } as unknown as ParsedBundleConfig;
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, root));
    const found = buildInspectorIssues(graph, config, [], root)
      .filter((issue) => issue.kind === "excluded_from_sync")
      .map((issue) => [issue.taskName, issue.title])
      .sort();
    expect(found).toEqual([
      ["run_link", '"./linked_nb" may not be deployed: it is a symbolic link.'],
      ["task_in_linked_dir", '"./src/linked_dir/helper.py" may not be deployed: it is in "src/linked_dir", a symbolic link.'],
      ["task_on_link", '"./src/linked_nb.py" may not be deployed: it is a symbolic link.'],
    ]);
    // A real target's output has the default sync.paths ["."] (#374): still checked.
    const withTarget = { ...config, sync: { paths: ["."] } } as ParsedBundleConfig;
    expect(
      buildInspectorIssues(graph, withTarget, [], root, "dev").filter((issue) => issue.kind === "excluded_from_sync"),
    ).toHaveLength(3);
  });
});
