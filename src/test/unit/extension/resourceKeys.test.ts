import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { parseYamlLocations } from "../../../bundle/sourceLocations.js";
import { findResourceKeyProblems } from "../../../bundle/resourceKeys.js";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

// What the CLI prints for each case is in the fixture's README (issue 511).
const sourceFile = (text: string, file = "/b/databricks.yml") => ({ file, doc: parse(text, { merge: true }), text, locations: parseYamlLocations(file, text) });

function check(text: string, cliOutput: unknown = parse(text, { merge: true })) {
  return findResourceKeyProblems(cliOutput, [sourceFile(text)]).map((finding) => ({
    id: `${finding.group}.${finding.key}`,
    line: finding.location?.line,
    title: finding.title,
  }));
}

describe("resource keys with a dot", () => {
  test("a dotted key is an error at its line; a plain key is not", () => {
    const text = "resources:\n  jobs:\n    nightly:\n      name: n\n    nightly.load:\n      name: l\n  schemas:\n    s.x:\n      name: s\n";
    expect(check(text)).toEqual([
      { id: "jobs.nightly.load", line: 5, title: 'The resource key "nightly.load" has a dot, which deploy doesn\'t accept, so deploy may fail.' },
      { id: "schemas.s.x", line: 8, title: 'The resource key "s.x" has a dot, which deploy doesn\'t accept, so deploy may fail.' },
    ]);
  });

  test("the fix names the key with _ in place of each dot", () => {
    const [finding] = findResourceKeyProblems(parse("resources:\n  jobs:\n    a.b.c:\n      name: n\n"), []);
    expect(finding!.fixHint).toContain('for example "a_b_c"');
    expect(finding!.fixHint).toContain("${resources.jobs.a.b.c...}");
    expect(finding!.location).toBeUndefined();
  });

  test("a key only in a target is found at the target's line, once", () => {
    const text = "targets:\n  dev:\n    resources:\n      pipelines:\n        p.q:\n          name: p\n  prod:\n    resources:\n      pipelines:\n        p.q:\n          name: p\n";
    expect(check(text)).toEqual([expect.objectContaining({ id: "pipelines.p.q", line: 5 })]);
  });

  test("a real target's output, merged into resources, is found at the target's line", () => {
    const text = "targets:\n  prod:\n    resources:\n      pipelines:\n        p.q:\n          name: p\n";
    expect(check(text, { resources: { pipelines: { "p.q": { name: "p" } } } })).toEqual([expect.objectContaining({ id: "pipelines.p.q", line: 5 })]);
  });

  test("a real target's output points at that target's line when other targets have the key too", () => {
    const text = "targets:\n  dev:\n    resources:\n      jobs:\n        a.b:\n          name: d\n  prod:\n    resources:\n      jobs:\n        a.b:\n          name: p\n";
    const output = (target: string) => ({ bundle: { target }, resources: { jobs: { "a.b": { name: "x" } } } });
    expect(check(text, output("prod"))).toEqual([expect.objectContaining({ id: "jobs.a.b", line: 10 })]);
    expect(check(text, output("dev"))).toEqual([expect.objectContaining({ id: "jobs.a.b", line: 5 })]);
  });

  test("the suggested name is one the bundle doesn't use yet", () => {
    // Keys are unique across every resource type and script, so "a_b" and "a_b_2" are both taken.
    const bundle = {
      resources: { jobs: { "a.b": { name: "x" }, a_b: { name: "y" } }, pipelines: { a_b_2: { name: "p" }, "c.d": { name: "q" } } },
      scripts: { c_d: { content: "echo" } },
    };
    const hints = findResourceKeyProblems(bundle, []).map((finding) => finding.fixHint);
    expect(hints[0]).toContain('for example "a_b_3"');
    expect(hints[1]).toContain('for example "c_d_2"');
  });

  test("two dotted keys that would share a suggestion get different ones", () => {
    const hints = findResourceKeyProblems({ resources: { jobs: { "x.y_z": {}, "x_y.z": {} } } }, []).map((finding) => finding.fixHint);
    expect(hints.map((hint) => hint.match(/for example "([^"]+)"/)?.[1])).toEqual(["x_y_z", "x_y_z_2"]);
  });

  test("near miss (resource_key_has_dot): dots elsewhere are fine: in a name, a task key's value, or a field", () => {
    expect(check("resources:\n  jobs:\n    nightly:\n      name: a.b\n      tags:\n        team.name: x\n")).toEqual([]);
  });
});

describe("the fixture, as the inspector reads it", () => {
  const bundleRoot = path.resolve(__dirname, "../../fixtures/resource-key-dot");

  test("each dotted key is an error in the issue list, including the job whose graph ID clashes", async () => {
    // The structural preview prints the YAML as written, so it stands in for the CLI output.
    const config = parse(readFileSync(path.join(bundleRoot, "databricks.yml"), "utf8").replace(/\r\n/g, "\n"), { merge: true }) as ParsedBundleConfig;
    const graph = await extractBundleGraph(config, bundleRoot);
    const issues = buildInspectorIssues(graph, config, [], bundleRoot).filter((issue) => issue.kind === "resource_key_has_dot");
    expect(issues.map((issue) => [issue.resourceId, issue.severity, path.basename(issue.file ?? ""), issue.line])).toEqual([
      ["resources.jobs.a.tasks.b", "error", "databricks.yml", 15],
      ["resources.pipelines.p.q", "error", "databricks.yml", 33],
    ]);
  });
});
