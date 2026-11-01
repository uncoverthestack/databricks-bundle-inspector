import { afterEach, describe, expect, test } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BundleGraph, ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues, missingBundleNameIssues } from "../../../bundle/issues.js";

const roots: string[] = [];

function makeBundle(text: string, name = "databricks.yml"): string {
  const root = mkdtempSync(path.join(tmpdir(), "bundle-name-"));
  roots.push(root);
  writeFileSync(path.join(root, name), text);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Each config is the structural preview's output, and each expectation what
// `databricks bundle validate -t <target>` did with a login (CLI v1.22.1, #340).
describe("missing bundle name", () => {
  test("a target can clear an inherited name", () => {
    const root = makeBundle('bundle: {name: base}\ntargets: {dev: {bundle: {name: ""}}, prod: {}}\n');
    const config = { bundle: { name: "base" }, targets: { dev: { bundle: { name: "" } }, prod: {} } } as ParsedBundleConfig;
    expect(missingBundleNameIssues(config, root)[0]?.title).toContain('fails for target "dev".');
  });

  test("a null target from the CLI's structural preview inherits the base settings", () => {
    const root = makeBundle("targets: {dev: null}\n");
    const config = { bundle: {}, targets: { dev: null } } as unknown as ParsedBundleConfig;
    expect(missingBundleNameIssues(config, root)).toHaveLength(1);
  });

  test("no name and no root_path: deploy fails, reported on databricks.yml", () => {
    const root = makeBundle("targets:\n  dev:\n    default: true\n");
    const config = { bundle: {}, targets: { dev: { default: true } } } as ParsedBundleConfig;
    const [issue, ...rest] = missingBundleNameIssues(config, root);
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({
      severity: "error",
      kind: "missing_bundle_name",
      file: path.join(root, "databricks.yml"),
      title:
        'The bundle has no name, so "databricks bundle deploy" fails. The Databricks CLI needs bundle: name: to make the deploy folder.',
    });
    // No `bundle:` line to point at.
    expect(issue?.line).toBeUndefined();
  });

  test.each([
    ["empty", "", { default: {} }],
    ["only a comment", "# just a comment\n", { default: {} }],
  ])("an %s databricks.yml: the CLI's default target fails", (_case, text, targets) => {
    const root = makeBundle(text);
    const issues = missingBundleNameIssues({ bundle: {}, targets } as ParsedBundleConfig, root);
    expect(issues.map((issue) => issue.id)).toEqual(["bundle:missing-name:default"]);
  });

  test.each([
    ["bundle:\n", 1],
    ["# my bundle\nbundle:\n  uuid: 80d8cf28-ef35-4645-bbe5-b46634077f6c\n", 2],
    ["include:\n  - a.yml\r\nbundle:\r\n", 3],
  ])("points at the bundle: line: %j", (text, line) => {
    const root = makeBundle(text);
    const [issue] = missingBundleNameIssues({ bundle: {}, targets: { default: {} } } as ParsedBundleConfig, root);
    expect(issue?.line).toBe(line);
  });

  test("an empty name counts as no name", () => {
    const root = makeBundle('bundle:\n  name: ""\n');
    const config = { bundle: { name: "" }, targets: { dev: {} } } as ParsedBundleConfig;
    expect(missingBundleNameIssues(config, root)).toHaveLength(1);
  });

  test("names only the targets that fail, when others set a name or a root_path", () => {
    const root = makeBundle("targets: {}\n");
    const config = {
      bundle: {},
      targets: {
        dev: { bundle: { name: "from-target" } },
        stage: { workspace: { root_path: "/Workspace/Users/me/.bundle/x/stage" } },
        prod: { mode: "production" },
        qa: {},
      },
    } as ParsedBundleConfig;
    const [issue] = missingBundleNameIssues(config, root);
    expect(issue?.title).toBe(
      'The bundle has no name, so "databricks bundle deploy" fails for targets "prod", "qa". The Databricks CLI needs bundle: name: to make the deploy folder.',
    );
  });

  test("one failing target out of two is named", () => {
    const root = makeBundle("targets: {}\n");
    const config = {
      bundle: {},
      targets: { dev: {}, prod: { workspace: { root_path: "/Workspace/Users/me/.bundle/x/prod" } } },
    } as ParsedBundleConfig;
    expect(missingBundleNameIssues(config, root)[0]?.title).toContain('fails for target "dev".');
  });

  test.each([
    ["a name", { bundle: { name: "demo" }, targets: { dev: {} } }],
    // Deploys, with only the CLI's "required field" warning.
    ["a root_path for the bundle", { bundle: {}, workspace: { root_path: "/x/${bundle.target}" }, targets: { dev: {}, prod: {} } }],
    ["a root_path for every target", { bundle: {}, targets: { dev: { workspace: { root_path: "/x/dev" } } } }],
    ["a name set by every target", { bundle: {}, targets: { dev: { bundle: { name: "from-target" } } } }],
  ])("nothing is said for %s", (_case, config) => {
    const root = makeBundle("targets: {}\n");
    expect(missingBundleNameIssues(config as ParsedBundleConfig, root)).toEqual([]);
  });

  test("uses databricks.yaml when that is the bundle file", () => {
    const root = makeBundle("targets:\n  dev: {}\n", "databricks.yaml");
    const [issue] = missingBundleNameIssues({ bundle: {}, targets: { dev: {} } } as ParsedBundleConfig, root);
    expect(issue?.file).toBe(path.join(root, "databricks.yaml"));
  });

  test("is checked in the structural preview only: with a target the CLI reports it", () => {
    const root = makeBundle("targets:\n  dev: {}\n");
    const graph: BundleGraph = { nodes: [], edges: [] };
    const config = { bundle: {}, targets: { dev: {} } } as ParsedBundleConfig;
    const kinds = (target?: string) =>
      buildInspectorIssues(graph, config, [], root, target).map((issue) => issue.kind);
    expect(kinds()).toContain("missing_bundle_name");
    expect(kinds("dev")).not.toContain("missing_bundle_name");
  });
});
