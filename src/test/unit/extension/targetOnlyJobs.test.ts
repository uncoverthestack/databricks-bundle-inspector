import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import { findTargetOnlyJobs } from "../../../bundle/targetOnlyJobs.js";
import { buildIssueItems } from "../../../webview/lib/issueItems.js";
import { targetOnlyJobNotes } from "../../../webview/lib/targetOnlyJobNotes.js";

// The structural preview of src/test/fixtures/target-only-jobs, captured with CLI v1.28.0: with
// no target, `resources.jobs` has only `shared`, and each target keeps its own jobs.
const ROOT = path.resolve(__dirname, "../../fixtures/target-only-jobs");
const preview = () => JSON.parse(readFileSync(path.join(ROOT, "validated-bundle.json"), "utf8")) as ParsedBundleConfig;

describe("jobs only a target writes, with no target picked", () => {
  test("each gets one note in the Issues list, at the first target's line", async () => {
    const bundle = preview();
    const graph = await extractBundleGraph(bundle, ROOT);
    const notes = targetOnlyJobNotes(graph.targetOnlyJobs).map((note) => ({
      title: note.title,
      severity: note.severity,
      // Forward slashes on every OS, so the expected paths read the same on Windows.
      at: `${path.relative(ROOT, note.file ?? "").split(path.sep).join("/")}:${note.line}`,
    }));
    expect(notes).toEqual([
      { title: 'Job "both" is only in targets "dev" and "prod": pick one to check it.', severity: "info", at: "databricks.yml:15" },
      { title: 'Job "nightly" is only in target "prod": pick prod to check it.', severity: "info", at: "databricks.yml:20" },
    ]);

    const items = buildIssueItems(graph as never, null, bundle, null, [], targetOnlyJobNotes(graph.targetOnlyJobs));
    // One line per row: no second line repeating the title.
    expect(items.map((item) => [item.group, item.severity, item.subtitle])).toEqual([
      ["Jobs Not Checked", "info", undefined],
      ["Jobs Not Checked", "info", undefined],
    ]);
  });

  test("the note stays out of the shared findings, so the Problems panel, report and command-line tool don't get it", async () => {
    const bundle = preview();
    const graph = await extractBundleGraph(bundle, ROOT);
    expect(buildInspectorIssues(graph, bundle, [], ROOT).filter((issue) => issue.kind === "job_only_in_target")).toEqual([]);
  });

  test("a picked target's output has no targets, so there is no note", () => {
    const picked = { bundle: { target: "prod" }, resources: { jobs: { shared: {}, both: {}, nightly: {} } } };
    expect(findTargetOnlyJobs(picked, [])).toEqual([]);
  });

  test("near miss (job_only_in_target): a job also in the bundle's own resources gets no note", () => {
    const bundle = { resources: { jobs: { shared: {} } }, targets: { dev: { resources: { jobs: { shared: {} } } } } };
    expect(findTargetOnlyJobs(bundle, [])).toEqual([]);
  });

  test("three targets are listed in full", () => {
    const notes = targetOnlyJobNotes([{ jobKey: "j", targets: ["dev", "test", "prod"] }]);
    expect(notes.map((note) => note.title)).toEqual(['Job "j" is only in targets "dev", "test" and "prod": pick one to check it.']);
  });
});
