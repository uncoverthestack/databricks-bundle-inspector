import { beforeAll, describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

/**
 * A notebook run with %run that reads one widget by a name only known at runtime and
 * another by its name (#602, case 3), from the run-child-dynamic-reads fixture's recorded
 * `bundle validate` output: one job per case. The runtime-named read doesn't create a
 * widget, so the named read fails the run when nothing sets it (probe
 * widget_run_child_dynamic_read, Databricks CLI v1.28.0), as it does in the task's own notebook.
 */
const ROOT = path.resolve("src/test/fixtures/run-child-dynamic-reads");
let byJob: Map<string, string[]>;

beforeAll(async () => {
  const bundle = JSON.parse(readFileSync(path.join(ROOT, "validated-bundle.json"), "utf8")) as ParsedBundleConfig;
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(bundle, ROOT));
  const jobOf = new Map(graph.nodes.map((node) => [node.id, node.parentId]));
  byJob = new Map();
  for (const issue of buildInspectorIssues(graph, bundle, [], ROOT)) {
    if (issue.kind !== "widget_not_set") continue;
    const job = String(jobOf.get(issue.taskId ?? "") ?? "").replace(/^resources\.jobs\./, "");
    byJob.set(job, [...(byJob.get(job) ?? []), issue.title]);
  }
});

const findings = (job: string) => byJob.get(job) ?? [];
const NEEDED = 'Notebook "./child", run with %run, reads widget "needed", which may not be set.';

describe("%run child with a read by a runtime name (#602)", () => {
  test("a named read is still checked next to a read by a variable", () => {
    expect(findings("variable_and_named")).toEqual([NEEDED]);
  });

  test("a named read is still checked next to getAll()", () => {
    expect(findings("get_all_and_named")).toEqual([NEEDED]);
  });

  test("control: the same named read alone", () => {
    expect(findings("named_only")).toEqual([NEEDED]);
  });

  test("near miss (widget_not_set): a read by a variable only", () => {
    expect(findings("variable_only")).toEqual([]);
  });

  test("near miss (widget_not_set): the named read has a default in the child", () => {
    expect(findings("named_with_default")).toEqual([]);
  });
});
