import test from "node:test";
import assert from "node:assert/strict";
import {
  getBundleDirFromEditor,
  isBundleFile,
} from "../extension/bundleContext.js";

test("isBundleFile matches supported bundle file names", () => {
  assert.equal(isBundleFile("databricks.yaml"), true);
  assert.equal(isBundleFile("databricks.yml"), true);
  assert.equal(isBundleFile("bundle.yaml"), false);
});

test("getBundleDirFromEditor returns bundle file directory", () => {
  const bundleDir = getBundleDirFromEditor({
    document: {
      fileName: "/workspace/project/databricks.yaml",
    },
  });

  assert.equal(bundleDir, "/workspace/project");
});

test("getBundleDirFromEditor ignores non-bundle files", () => {
  const bundleDir = getBundleDirFromEditor({
    document: {
      fileName: "/workspace/project/not-databricks.yaml",
    },
  });

  assert.equal(bundleDir, undefined);
});

test("getBundleDirFromEditor handles missing editor", () => {
  assert.equal(getBundleDirFromEditor(), undefined);
});
