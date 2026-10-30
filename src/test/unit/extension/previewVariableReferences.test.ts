import { describe, expect, test } from "@jest/globals";
import { extractBundleGraph, type BundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { withPreviewVariableReferences } from "../../../bundle/graph/previewVariableReferences.js";

// #230: with a target, the CLI hands over values, not the ${var...} they came from.
function bundle(catalog: string, extraTask?: string): ParsedBundleConfig {
  return {
    bundle: { name: "b" },
    variables: { catalog: { default: "main" } },
    resources: {
      jobs: {
        j: {
          name: "j",
          tasks: [
            { task_key: "load", notebook_task: { notebook_path: "./nb", base_parameters: { catalog } } },
            {
              task_key: "loop",
              for_each_task: {
                inputs: "[1, 2]",
                task: { task_key: "inner", notebook_task: { notebook_path: "./nb", base_parameters: { catalog } } },
              },
            },
            ...(extraTask ? [{ task_key: extraTask, notebook_task: { notebook_path: "./nb" } }] : []),
          ],
        },
      },
    },
  } as ParsedBundleConfig;
}

/** The check the extension passes: the target deployed `deployed`, the preview wrote `preview`. */
const check = (deployed: ParsedBundleConfig, preview: ParsedBundleConfig) => ({ deployed, preview, resolution: preview, target: "dev" });

const names = (graph: BundleGraph, id: string) =>
  graph.nodes.find((node) => node.id.endsWith(id))?.taskData?.variableReferences.map((ref) => ref.variableName);

describe("withPreviewVariableReferences", () => {
  test("gives each task of the target the variables it uses in the preview, with their nodes and edges", async () => {
    const preview = await extractBundleGraph(bundle("${var.catalog}"), "/b");
    const target = await extractBundleGraph(bundle("main"), "/b");
    expect(names(target, ".load")).toEqual([]);

    const shown = withPreviewVariableReferences(target, preview, check(bundle("main"), bundle("${var.catalog}")));
    expect(names(shown, ".load")).toEqual(["catalog"]);
    const loop = shown.nodes.find((node) => node.id.endsWith(".loop"))?.taskData;
    expect(loop?.nestedTask?.variableReferences.map((ref) => ref.variableName)).toEqual(["catalog"]);
    expect(shown.nodes.some((node) => node.id === "var:catalog")).toBe(true);
    expect(shown.edges.filter((edge) => edge.kind === "uses" && edge.target === "var:catalog").length).toBeGreaterThan(0);
  });

  test("leaves a task only the target has, and doesn't add one only the preview has", async () => {
    const preview = await extractBundleGraph(bundle("${var.catalog}", "only_in_preview"), "/b");
    const target = await extractBundleGraph(bundle("main", "only_in_target"), "/b");
    const shown = withPreviewVariableReferences(target, preview, check(bundle("main", "only_in_target"), bundle("${var.catalog}", "only_in_preview")));
    expect(names(shown, ".only_in_target")).toEqual([]);
    expect(shown.nodes.some((node) => node.id.endsWith(".only_in_preview"))).toBe(false);
    expect(shown.nodes.filter((node) => node.id === "var:catalog")).toHaveLength(1);
    expect(shown.nodes.filter((node) => !target.nodes.some((t) => t.id === node.id)).every((node) => node.id.startsWith("var:"))).toBe(true);
  });

  test("doesn't change the graphs it is given, and adds nothing twice", async () => {
    const preview = await extractBundleGraph(bundle("${var.catalog}"), "/b");
    const target = await extractBundleGraph(bundle("main"), "/b");
    const before = JSON.stringify(target);
    const sameCheck = check(bundle("main"), bundle("${var.catalog}"));
    const once = withPreviewVariableReferences(target, preview, sameCheck);
    expect(JSON.stringify(target)).toBe(before);
    const twice = withPreviewVariableReferences(once, preview, sameCheck);
    expect(twice.nodes.length).toBe(once.nodes.length);
    expect(twice.edges.length).toBe(once.edges.length);
  });

  // #332: the preview doesn't apply a target's overrides.
  test("drops a reference whose setting the target overrode, and keeps the rest", async () => {
    const written = bundle("${var.catalog}");
    (written.resources!.jobs!.j as { tasks: Array<Record<string, unknown>> }).tasks.push({
      task_key: "two",
      notebook_task: { notebook_path: "./nb", base_parameters: { kept: "${var.catalog}_x", overridden: "${var.catalog}" } },
    });
    const deployed = bundle("main");
    (deployed.resources!.jobs!.j as { tasks: Array<Record<string, unknown>> }).tasks.push({
      task_key: "two",
      notebook_task: { notebook_path: "./nb", base_parameters: { kept: "main_x", overridden: "special_dev_catalog" } },
    });
    const shown = withPreviewVariableReferences(await extractBundleGraph(deployed, "/b"), await extractBundleGraph(written, "/b"), check(deployed, written));
    const refs = shown.nodes.find((node) => node.id.endsWith(".two"))?.taskData?.variableReferences.map((ref) => ref.yamlPath);
    expect(refs).toEqual(["tasks.two.notebook_task.base_parameters.kept"]);
  });

  test("drops a reference whose setting the target doesn't have, keeps one it can't resolve", async () => {
    const written = bundle("${var.catalog}");
    const tasks = (written.resources!.jobs!.j as { tasks: Array<Record<string, unknown>> }).tasks;
    tasks.push({ task_key: "three", notebook_task: { notebook_path: "./nb", base_parameters: { gone: "${var.catalog}", lookup: "${var.warehouse}" } } });
    const deployed = bundle("main");
    (deployed.resources!.jobs!.j as { tasks: Array<Record<string, unknown>> }).tasks.push({
      task_key: "three",
      notebook_task: { notebook_path: "./nb", base_parameters: { lookup: "1234567890abcdef" } },
    });
    const shown = withPreviewVariableReferences(await extractBundleGraph(deployed, "/b"), await extractBundleGraph(written, "/b"), check(deployed, written));
    const refs = shown.nodes.find((node) => node.id.endsWith(".three"))?.taskData?.variableReferences.map((ref) => ref.variableName);
    expect(refs).toEqual(["warehouse"]);
  });
});
