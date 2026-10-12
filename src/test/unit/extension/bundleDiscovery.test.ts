import { describe, test, expect } from "@jest/globals";
import {
  MAX_BUNDLES_CHECKED_ON_OPEN,
  SKIPPED_FOLDERS_GLOB,
  selectBundleRoots,
} from "../../../bundle/bundleDiscovery.js";

describe("selectBundleRoots", () => {
  test("returns the folder of each bundle file, nested ones included", () => {
    expect(
      selectBundleRoots([
        "/repo/teams/sales/etl/databricks.yml",
        "/repo/databricks.yml",
        "/repo/teams/ops/databricks.yaml",
      ]),
    ).toEqual(["/repo", "/repo/teams/ops", "/repo/teams/sales/etl"]);
  });

  test("counts a folder with both databricks.yml and databricks.yaml once", () => {
    expect(
      selectBundleRoots(["/repo/app/databricks.yml", "/repo/app/databricks.yaml"]),
    ).toEqual(["/repo/app"]);
  });

  test("skips bundles inside installed or generated folders", () => {
    expect(
      selectBundleRoots([
        "/repo/node_modules/pkg/databricks.yml",
        "/repo/.venv/lib/site-packages/templates/databricks.yml",
        "/repo/venv/templates/databricks.yml",
        "/repo/app/.databricks/bundle/dev/databricks.yml",
        "/repo/.git/databricks.yml",
        "/repo/app/databricks.yml",
      ]),
    ).toEqual(["/repo/app"]);
  });

  test("keeps a folder whose name only starts like a skipped one", () => {
    expect(selectBundleRoots(["/repo/venv-tools/databricks.yml"])).toEqual([
      "/repo/venv-tools",
    ]);
  });

  test("keeps the bundles closest to the top when there are more than the limit", () => {
    const deep = Array.from({ length: 30 }, (_, i) => `/repo/deep/more/b${i}/databricks.yml`);
    const roots = selectBundleRoots([...deep, "/repo/top/databricks.yml", "/repo/databricks.yml"]);

    expect(roots).toHaveLength(MAX_BUNDLES_CHECKED_ON_OPEN);
    expect(roots.slice(0, 2)).toEqual(["/repo", "/repo/top"]);
  });

  test("returns nothing for no files or a zero limit", () => {
    expect(selectBundleRoots([])).toEqual([]);
    expect(selectBundleRoots(["/repo/databricks.yml"], 0)).toEqual([]);
  });
});

describe("SKIPPED_FOLDERS_GLOB", () => {
  test("lists every skipped folder at any depth", () => {
    expect(SKIPPED_FOLDERS_GLOB).toBe("**/{node_modules,.git,.databricks,.venv,venv}/**");
  });
});
