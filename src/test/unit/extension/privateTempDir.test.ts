import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundleTempDir, privateBundleTempDir } from "../../../databricksCli/restrictedExecution.js";

// Real folders in a throwaway temp root, standing in for a /tmp every user shares (#469).
// Owners and permission bits are POSIX only; Windows gives each user their own temp folder.
(process.platform === "win32" ? describe.skip : describe)("privateBundleTempDir", () => {
  // Read here, not at load: Jest runs a skipped block's body too, and Windows has no getuid.
  const uid = process.getuid?.() ?? 0;
  let root: string;
  let outside: string;
  const bundle = "/work/some bundle";
  const usual = () => bundleTempDir(bundle, root);
  const mode = (folder: string) => statSync(folder).mode & 0o777;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "bdi-private-tmp-"));
    outside = mkdtempSync(path.join(os.tmpdir(), "bdi-private-elsewhere-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("creates the usual folder and its parent for this user only, and keeps using it", () => {
    expect(privateBundleTempDir(bundle, root, uid)).toBe(usual());
    expect(mode(usual())).toBe(0o700);
    expect(mode(path.dirname(usual()))).toBe(0o700);
    expect(privateBundleTempDir(bundle, root, uid)).toBe(usual());
  });

  test("a folder someone else could write to is not used", () => {
    mkdirSync(usual(), { recursive: true });
    chmodSync(usual(), 0o777);
    const used = privateBundleTempDir(bundle, root, uid);
    expect(used).not.toBe(usual());
    expect(mode(used)).toBe(0o700);
    // The same private folder for the rest of the session.
    expect(privateBundleTempDir(bundle, root, uid)).toBe(used);
  });

  test("a parent someone else could write to is not used either", () => {
    mkdirSync(path.dirname(usual()), { recursive: true });
    chmodSync(path.dirname(usual()), 0o777);
    expect(privateBundleTempDir(bundle, root, uid)).not.toBe(usual());
  });

  test("a link in place of the folder or its parent is not followed", () => {
    mkdirSync(path.dirname(usual()), { recursive: true, mode: 0o700 });
    symlinkSync(outside, usual());
    expect(privateBundleTempDir(bundle, root, uid)).not.toBe(usual());

    const other = "/work/other bundle";
    const otherRoot = mkdtempSync(path.join(os.tmpdir(), "bdi-private-tmp-"));
    try {
      symlinkSync(outside, path.join(otherRoot, "databricks-bundle-inspector"));
      expect(privateBundleTempDir(other, otherRoot, uid)).not.toBe(bundleTempDir(other, otherRoot));
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  test("a folder another user owns is not used", () => {
    privateBundleTempDir(bundle, root, uid);
    expect(privateBundleTempDir(bundle, root, uid + 1)).not.toBe(usual());
  });

  test("without user ids (Windows), the usual folder", () => {
    expect(privateBundleTempDir(bundle, root, undefined)).toBe(usual());
  });
});
