import { describe, test, expect } from "@jest/globals";
import {
  isBundleFile,
  getBundleDirFromEditor,
} from "../../bundle/bundleContext.js";

describe("isBundleFile", () => {
  test("returns true for databricks.yaml", () => {
    expect(isBundleFile("databricks.yaml")).toBe(true);
  });

  test("returns true for databricks.yml", () => {
    expect(isBundleFile("databricks.yml")).toBe(true);
  });

  test("returns false for unsupported file names", () => {
    expect(isBundleFile("bundle.yml")).toBe(false);
  });
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
