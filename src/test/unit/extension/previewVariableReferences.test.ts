import { describe, expect, test } from "@jest/globals";
import { extractBundleGraph, type BundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { withPreviewVariableReferences } from "../../../bundle/graph/previewVariableReferences.js";

// #230: with a target, the CLI hands over values, not the ${var...} they came from.
function bundle(catalog: string, extraTask?: string): ParsedBundleConfig {
  return {
    bundle: { name: "b" },
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

const names = (graph: BundleGraph, id: string) =>
  graph.nodes.find((node) => node.id.endsWith(id))?.taskData?.variableReferences.map((ref) => ref.variableName);

describe("withPreviewVariableReferences", () => {
  test("gives each task of the target the variables it uses in the preview, with their nodes and edges", async () => {
    const preview = await extractBundleGraph(bundle("${var.catalog}"), "/b");
    const target = await extractBundleGraph(bundle("dev_catalog"), "/b");
    expect(names(target, ".load")).toEqual([]);

    const shown = withPreviewVariableReferences(target, preview);
    expect(names(shown, ".load")).toEqual(["catalog"]);
    const loop = shown.nodes.find((node) => node.id.endsWith(".loop"))?.taskData;
    expect(loop?.nestedTask?.variableReferences.map((ref) => ref.variableName)).toEqual(["catalog"]);
    expect(shown.nodes.some((node) => node.id === "var:catalog")).toBe(true);
    expect(shown.edges.filter((edge) => edge.kind === "uses" && edge.target === "var:catalog").length).toBeGreaterThan(0);
  });

  test("leaves a task only the target has, and doesn't add one only the preview has", async () => {
    const preview = await extractBundleGraph(bundle("${var.catalog}", "only_in_preview"), "/b");
    const target = await extractBundleGraph(bundle("dev_catalog", "only_in_target"), "/b");
    const shown = withPreviewVariableReferences(target, preview);
    expect(names(shown, ".only_in_target")).toEqual([]);
    expect(shown.nodes.some((node) => node.id.endsWith(".only_in_preview"))).toBe(false);
    expect(shown.nodes.length).toBe(target.nodes.length + 1); // var:catalog
  });

  test("doesn't change the graphs it is given, and adds nothing twice", async () => {
    const preview = await extractBundleGraph(bundle("${var.catalog}"), "/b");
    const target = await extractBundleGraph(bundle("dev_catalog"), "/b");
    const before = JSON.stringify(target);
    const once = withPreviewVariableReferences(target, preview);
    expect(JSON.stringify(target)).toBe(before);
    const twice = withPreviewVariableReferences(once, preview);
    expect(twice.nodes.length).toBe(once.nodes.length);
    expect(twice.edges.length).toBe(once.edges.length);
  });
});
