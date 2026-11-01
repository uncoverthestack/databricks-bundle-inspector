import { afterEach, describe, expect, test } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BundleGraph, ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues, emptyBundleNameInRootPathIssues } from "../../../bundle/issues.js";

const roots: string[] = [];

function makeBundle(text: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "bundle-root-path-"));
  roots.push(root);
  writeFileSync(path.join(root, "databricks.yml"), text);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ROOT_PATH = "/Workspace/Users/${workspace.current_user.userName}/.bundle/${bundle.name}/${bundle.target}";
const TITLE = (folder: string) =>
  `root_path uses \${bundle.name}, but the bundle has no name, so it deploys to "${folder}". ` +
  "Another bundle with no name and the same root_path deploys to the same folder and can delete this bundle's resources.";

// Each config is the structural preview's output, and each folder what
// `databricks bundle validate -t <target>` resolved with a login (CLI v1.22.1, #341).
describe("empty bundle name in root_path", () => {
  test("a target can clear an inherited name while keeping the base root_path", () => {
    const root = makeBundle(`bundle: {name: base}\nworkspace:\n  root_path: ${ROOT_PATH}\ntargets: {dev: {bundle: {name: ""}}, prod: {}}\n`);
    const config = { bundle: { name: "base" }, workspace: { root_path: ROOT_PATH }, targets: { dev: { bundle: { name: "" } }, prod: {} } } as ParsedBundleConfig;
    expect(emptyBundleNameInRootPathIssues(config, root)).toMatchObject([{ id: "bundle:empty-name-root-path:dev" }]);
  });

  test("a null target inherits the base root_path", () => {
    const root = makeBundle(`workspace:\n  root_path: ${ROOT_PATH}\ntargets: {dev: null}\n`);
    const config = { bundle: {}, workspace: { root_path: ROOT_PATH }, targets: { dev: null } } as unknown as ParsedBundleConfig;
    expect(emptyBundleNameInRootPathIssues(config, root)).toHaveLength(1);
  });

  test("no name, root_path in the bundle: warns on the root_path line", () => {
    const root = makeBundle(`workspace:\n  root_path: ${ROOT_PATH}\ntargets:\n  dev: {default: true}\n`);
    const config = { bundle: {}, workspace: { root_path: ROOT_PATH }, targets: { dev: {} } } as ParsedBundleConfig;
    expect(emptyBundleNameInRootPathIssues(config, root)).toEqual([
      {
        id: "bundle:empty-name-root-path:dev",
        severity: "warning",
        kind: "empty_bundle_name_in_root_path",
        title: TITLE(".bundle//dev"),
        fixHint: "Add a name under bundle: in databricks.yml.",
        file: path.join(root, "databricks.yml"),
        line: 2,
      },
    ]);
  });

  test.each([
    ["no name, root_path in a target", { bundle: {}, targets: { dev: { workspace: { root_path: ROOT_PATH } } } }],
    // The CLI prints no warning for this one.
    ['name: ""', { bundle: { name: "" }, workspace: { root_path: ROOT_PATH }, targets: { dev: {} } }],
    ["an empty bundle: (null)", { bundle: {}, workspace: { root_path: ROOT_PATH }, targets: { dev: {} } }],
  ])("warns for %s", (_case, config) => {
    const root = makeBundle("targets: {}\n");
    const issues = emptyBundleNameInRootPathIssues(config as ParsedBundleConfig, root);
    expect(issues.map((issue) => issue.title)).toEqual([TITLE(".bundle//dev")]);
  });

  test("one warning per target folder, and the CLI's default target when there are none", () => {
    const root = makeBundle("");
    const twoTargets = { bundle: {}, workspace: { root_path: ROOT_PATH }, targets: { dev: {}, prod: {} } };
    expect(emptyBundleNameInRootPathIssues(twoTargets as ParsedBundleConfig, root).map((i) => i.id)).toEqual([
      "bundle:empty-name-root-path:dev",
      "bundle:empty-name-root-path:prod",
    ]);
    const noTargets = { bundle: {}, workspace: { root_path: ROOT_PATH } } as ParsedBundleConfig;
    expect(emptyBundleNameInRootPathIssues(noTargets, root).map((i) => i.title)).toEqual([
      TITLE(".bundle//default"),
    ]);
  });

  test("targets that share one folder get one warning", () => {
    const root = makeBundle("");
    const config = { bundle: {}, workspace: { root_path: "/Shared/.bundle/${bundle.name}" }, targets: { dev: {}, prod: {} } };
    expect(emptyBundleNameInRootPathIssues(config as ParsedBundleConfig, root).map((i) => i.title)).toEqual([
      TITLE(".bundle/"),
    ]);
  });

  test.each([
    ["a name", { bundle: { name: "b" }, workspace: { root_path: ROOT_PATH }, targets: { dev: {} } }],
    ["a name set by the target", { bundle: {}, workspace: { root_path: ROOT_PATH }, targets: { dev: { bundle: { name: "t" } } } }],
    ["a root_path without ${bundle.name}", { bundle: {}, workspace: { root_path: "/Workspace/Shared/fixed/${bundle.target}" }, targets: { dev: {} } }],
    ["a target root_path without ${bundle.name}", { bundle: {}, workspace: { root_path: ROOT_PATH }, targets: { dev: { workspace: { root_path: "/x/dev" } } } }],
    ["no root_path (missing_bundle_name covers it)", { bundle: {}, targets: { dev: {} } }],
  ])("nothing is said for %s", (_case, config) => {
    const root = makeBundle("targets: {}\n");
    expect(emptyBundleNameInRootPathIssues(config as ParsedBundleConfig, root)).toEqual([]);
  });

  test("is checked in the structural preview only, and never with missing_bundle_name", () => {
    const root = makeBundle("");
    const graph: BundleGraph = { nodes: [], edges: [] };
    const config = { bundle: {}, workspace: { root_path: ROOT_PATH }, targets: { dev: {} } } as ParsedBundleConfig;
    const kinds = (target?: string) =>
      buildInspectorIssues(graph, config, [], root, target).map((issue) => issue.kind);
    expect(kinds()).toContain("empty_bundle_name_in_root_path");
    expect(kinds()).not.toContain("missing_bundle_name");
    expect(kinds("dev")).not.toContain("empty_bundle_name_in_root_path");
  });
});
