import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildJobUses } from "../../../bundle/jobUses.js";
import { buildBundleOverview } from "../../../bundle/bundleOverview.js";

// Expected answers: the joining rule from issue 535, with Databricks' parameter order (a job
// parameter wins over a task parameter of the same name, docs.databricks.com/aws/en/jobs/job-parameters).
// The structural preview, `bundle validate --target __bundle_inspector_probe__` on CLI v1.27.0,
// returns this fixture's YAML unchanged, `${var.scope}` included, so the YAML stands in for it.
const bundleRoot = path.resolve(__dirname, "../../fixtures/runtime-secrets");
const JOB = "resources.jobs.runtime_secrets";

function fixtureConfig(fill?: Record<string, string>): ParsedBundleConfig {
  let text = readFileSync(path.join(bundleRoot, "resources/job.yml"), "utf8");
  // A picked target: the CLI fills variables in its output, as `bundle validate -t dev` did here.
  for (const [from, to] of Object.entries(fill ?? {})) text = text.replaceAll(from, to);
  const parsed = parse(text) as { resources: ParsedBundleConfig["resources"] };
  return { bundle: { name: "runtime_secrets" }, include: ["resources/job.yml"], resources: parsed.resources } as ParsedBundleConfig;
}

async function uses(fill?: Record<string, string>) {
  const config = fixtureConfig(fill);
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, bundleRoot));
  const secrets = buildJobUses(graph, JOB).filter((item) => item.kind === "secret_scope");
  return { graph, secrets: secrets.map((item) => `${item.label} [${item.source}] ${item.taskNames.join(",")}${item.byDefault ? " by default" : ""}`) };
}

describe("secret scopes set at run time (issue 535)", () => {
  test("structural preview: unknown scopes are never joined, except through one job parameter", async () => {
    expect((await uses()).secrets).toEqual([
      "billing-kv [workspace] e_literal by default",
      "From job parameter shared_scope [runtime] c_shared,d_shared",
      "From parameter task_scope [runtime] f_variable",
      "Set at run time [runtime] a_built",
      "Set at run time [runtime] b_built",
    ]);
  });

  test("a picked target fills the variable: the scope joins the bundle's own, by default", async () => {
    expect((await uses({ "${var.scope}": "app-dev-kv" })).secrets).toEqual([
      "app-dev-kv [bundle] c_shared,d_shared,f_variable by default",
      "billing-kv [workspace] e_literal by default",
      "Set at run time [runtime] a_built",
      "Set at run time [runtime] b_built",
    ]);
  });

  test("the overview lists unknown scopes in the job's details and draws no box for them", async () => {
    const { graph } = await uses();
    const overview = buildBundleOverview(graph, []);
    const job = overview.groups.flatMap((group) => group.items).find((item) => item.id === JOB)!;
    expect(job.runtimeSecrets).toEqual([
      { label: "From job parameter shared_scope", taskNames: ["c_shared", "d_shared"] },
      { label: "From parameter task_scope", taskNames: ["f_variable"] },
      { label: "Set at run time", taskNames: ["a_built"] },
      { label: "Set at run time", taskNames: ["b_built"] },
    ]);
    const boxes = overview.groups.flatMap((group) => group.items.map((item) => item.label));
    expect(boxes.filter((label) => /run time|parameter/.test(label))).toEqual([]);
    // The scope a task parameter gives by default is a real box, linked to its job.
    expect(overview.links.some((link) => link.from === JOB && link.to === "secret:billing-kv")).toBe(true);
  });
});

describe("scope names given by a parameter (issue 535)", () => {
  test("a parameter that gives a scope's resource key, not its name, gets the name warning", async () => {
    const { buildInspectorIssues } = await import("../../../bundle/issues.js");
    // e_literal's parameter set to "app", the key of the scope named app-dev-kv.
    const config = fixtureConfig({ "billing-kv": "app" });
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, bundleRoot));
    const found = buildInspectorIssues(graph, config, [], bundleRoot)
      .filter((issue) => issue.kind === "secret_scope_name_mismatch")
      .map((issue) => `${issue.taskName}: ${issue.title} @ ${path.basename(issue.file ?? "")}:${issue.line}`);
    expect(found).toEqual(['e_literal: Secret scope "app" may not exist. Did you mean "app-dev-kv"? @ task_scope.py:2']);
  });
});
