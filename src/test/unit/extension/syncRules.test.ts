import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSyncFilter } from "../../../bundle/syncRules.js";

let bundleRoot: string;

beforeAll(async () => {
  bundleRoot = await mkdtemp(path.join(tmpdir(), "bdi-sync-test-"));
  await mkdir(path.join(bundleRoot, "src", "nested"), { recursive: true });
  await writeFile(
    path.join(bundleRoot, ".gitignore"),
    "src/__pycache__/\nsrc/ignored.py\nsrc/ignored_but_included/\nsrc/nested/*.log\n",
    "utf8",
  );
  await writeFile(
    path.join(bundleRoot, "src", "nested", ".gitignore"),
    "nested_ignored.py\n!keep.log\n",
    "utf8",
  );
});

afterAll(async () => {
  await rm(bundleRoot, { recursive: true, force: true });
});

function synced(relPaths: string[], sync?: { include?: string[]; exclude?: string[] }) {
  const isSynced = createSyncFilter(bundleRoot, sync);
  return Object.fromEntries(
    relPaths.map((rel) => [rel, isSynced(path.join(bundleRoot, rel))]),
  );
}

// Expected values match `databricks bundle sync --dry-run` on CLI v1.17.0.
describe("createSyncFilter", () => {
  test("skips files matched by .gitignore, even outside a git repository", () => {
    expect(
      synced(["src/kept.py", "src/ignored.py", "src/__pycache__/x.pyc"]),
    ).toEqual({
      "src/kept.py": true,
      "src/ignored.py": false,
      "src/__pycache__/x.pyc": false,
    });
  });

  test("applies nested .gitignore files, which cannot re-include a parent's match", () => {
    expect(
      synced([
        "src/nested/nested_ignored.py",
        "src/nested/other.log",
        "src/nested/keep.log",
        "src/nested/ok.py",
      ]),
    ).toEqual({
      "src/nested/nested_ignored.py": false,
      "src/nested/other.log": false,
      "src/nested/keep.log": false,
      "src/nested/ok.py": true,
    });
  });

  test("sync.include adds back gitignored files", () => {
    expect(
      synced(["src/ignored_but_included/i.py"], {
        include: ["src/ignored_but_included/**"],
      }),
    ).toEqual({ "src/ignored_but_included/i.py": true });
  });

  test("sync.exclude uses gitignore syntax and wins over sync.include", () => {
    expect(
      synced(
        ["src/both/b.py", "src/plain_dir/p.py", "src/deep/a/x.tmp", "src/keep.py"],
        { exclude: ["src/both/**", "src/plain_dir", "*.tmp"], include: ["src/both/**"] },
      ),
    ).toEqual({
      "src/both/b.py": false,
      "src/plain_dir/p.py": false,
      "src/deep/a/x.tmp": false,
      "src/keep.py": true,
    });
  });

  test("never syncs .databricks or .git", () => {
    expect(synced([".databricks/.gitignore", ".git/HEAD"])).toEqual({
      ".databricks/.gitignore": false,
      ".git/HEAD": false,
    });
  });

  test("applies a parent .gitignore only when the bundle is inside a git repository", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "bdi-sync-repo-"));
    try {
      const bundle = path.join(repo, "sub");
      await mkdir(path.join(bundle, "src"), { recursive: true });
      await writeFile(path.join(repo, ".gitignore"), "parent_ignored.py\n", "utf8");
      const file = path.join(bundle, "src", "parent_ignored.py");

      expect(createSyncFilter(bundle)(file)).toBe(true);
      await mkdir(path.join(repo, ".git"));
      expect(createSyncFilter(bundle)(file)).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("treats files outside the bundle root as synced", () => {
    const isSynced = createSyncFilter(bundleRoot);
    expect(isSynced(path.join(path.dirname(bundleRoot), "shared", "lib.py"))).toBe(true);
  });
});
