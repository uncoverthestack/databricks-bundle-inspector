import { describe, expect, test } from "@jest/globals";
import { bundleReviewReport, type BundleReviewContext } from "../../../bundle/bundleReviewReport.js";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import type { InspectorIssue } from "../../../bundle/issues.js";
import { REVIEW_REPORT_MAX_CHARACTERS, jobReviewReport } from "../../../bundle/reviewReport.js";
import { reportLocation } from "../../../bundle/reportLocation.js";
import { buildPipelineView, pipelineReviewSummary } from "../../../webview/lib/pipelineView.js";

const context: BundleReviewContext = {
  bundleRoot: "/repo", targetLabel: "structural preview", structuralPreview: true,
  cliVersion: "1.26.0", extensionVersion: "0.7.0", checkedAt: new Date("2026-11-12T12:00:00Z"),
};
const fixture = (): ParsedBundleConfig => ({
  bundle: { name: "sales" },
  variables: { schema: { default: "daily" }, unresolved: {} },
  resources: {
    jobs: {
      clean: { name: "Clean", tasks: [] },
      daily: { name: "Daily", tasks: [{ task_key: "load", pipeline_task: { pipeline_id: "${resources.pipelines.ingest.id}" } }] },
    },
    pipelines: { ingest: { name: "Ingest", catalog: "main", schema: "${resources.schemas.data.name}", libraries: [] } },
    catalogs: { main: { name: "main" } },
    schemas: { data: { name: "${var.schema}", catalog_name: "main" } },
    volumes: { raw: { name: "raw", catalog_name: "main", schema_name: "daily" } },
    sql_warehouses: { wh: { name: "Warehouse" } },
    clusters: { shared: { cluster_name: "Shared" } },
    secret_scopes: { scope: { name: "Scope" } },
    dashboards: { dash: { display_name: "Dashboard" } },
  },
} as ParsedBundleConfig);
const problem = (n = 1, severity: InspectorIssue["severity"] = "error"): InspectorIssue => ({
  id: String(n), kind: "missing_file", severity, title: `Problem ${n}`, detail: `Full explanation ${n}`,
  taskId: "resources.jobs.daily.tasks.load", taskName: "load", file: "/repo/resources/daily.yml", line: n,
});
async function report(parsed = fixture(), issues: InspectorIssue[] = [], ctx = context) {
  const graph = await extractBundleGraph(parsed);
  return bundleReviewReport(parsed, graph, issues, ctx);
}

describe("whole-bundle review (#410)", () => {
  test("inventories every resource kind, variables, relationships, counts and provenance", async () => {
    const markdown = await report();
    for (const heading of ["Jobs", "Pipelines", "Catalogs", "Schemas", "Volumes", "SQL warehouses", "Clusters", "Secret scopes", "Other resources: dashboards", "Variables"]) expect(markdown).toContain(`#### ${heading}`);
    expect(markdown).toContain("10 resources, 2 variables");
    expect(markdown).toContain("| Databricks CLI | 1.26.0 |");
    expect(markdown).toContain("| Checked | 2026-11-12T12:00:00.000Z |");
    expect(markdown).toContain("main.daily.raw");
    expect(markdown).toContain("schemas.data");
    expect(markdown).toContain("not checked yet");
    expect(markdown).toContain("unresolved");
    expect(markdown).not.toContain("Selected job");
    expect(markdown.indexOf("### Inventory")).toBeLessThan(markdown.indexOf("### Not checked"));
    expect(markdown.indexOf("### Not checked")).toBeLessThan(markdown.indexOf("### Bundle diagram"));
    // The pipeline's schema link (#403) is in the shared overview model.
    const schemaTable = markdown.split("#### Schemas")[1]!.split("#### Volumes")[0]!;
    expect(schemaTable).toContain("ingest");
  });

  test("problem rows lead each table, clean rows fold, summaries stop at three, details include every finding", async () => {
    const markdown = await report(fixture(), Array.from({ length: 16 }, (_, i) => problem(i + 1, i === 0 ? "warning" : "error")));
    const jobs = markdown.split("#### Jobs")[1]!.split("#### Pipelines")[0]!;
    expect(jobs.indexOf("| daily |")).toBeLessThan(jobs.indexOf("<details>"));
    expect(jobs.indexOf("<details>")).toBeLessThan(jobs.indexOf("| clean |"));
    expect(jobs).toContain("and 13 more");
    expect(markdown).toContain("Full explanation 16");
    expect(markdown).toContain("resources/daily.yml:16");
    expect(markdown).toContain("**daily / load**");
    expect(markdown.indexOf("### Errors")).toBeLessThan(markdown.indexOf("### Warnings"));
    expect(markdown).toContain("Files with problems");
  });

  test("a clean bundle says none for checked resources and explicitly names unchecked groups", async () => {
    const markdown = await report();
    expect(markdown).toContain("**0 errors, 0 warnings**");
    expect(markdown).toContain("<summary>2 jobs with no reported problems</summary>");
    expect(markdown).toContain("Resource groups with no checks yet:");
    expect(markdown).toContain("| scope | Scope |");
  });

  test("file totals include the bundle definition and includes that define no resources", async () => {
    const markdown = await report(fixture(), [], { ...context, bundleFiles: ["/repo/databricks.yml", "/repo/variables.yml"] });
    expect(markdown).toContain("2 files.");
    expect(markdown).toContain("2 files with no reported problems.");
  });

  test.each([50, 51])("a diagram is drawn through 50 resources, not 51 (%i)", async count => {
    const parsed = { bundle: { name: "many" }, resources: { jobs: Object.fromEntries(Array.from({ length: count }, (_, i) => [`j${i}`, { tasks: [] }])) } } as ParsedBundleConfig;
    const markdown = await report(parsed);
    expect(markdown.includes("```mermaid")).toBe(count === 50);
    if (count === 51) expect(markdown).toContain("51 resources, more than 50");
  });

  test("the picture uses error and warning styles and links only known resources", async () => {
    const markdown = await report(fixture(), [problem(), { ...problem(2, "warning"), taskId: undefined, resourceId: "resources.pipelines.ingest" } as unknown as InspectorIssue]);
    expect(markdown).toMatch(/\["jobs: daily"\]:::error/);
    expect(markdown).toMatch(/\["pipelines: ingest"\]:::warn/);
    expect(markdown).toMatch(/r\d+ --> r\d+/);
  });

  test("real-target values retain default, target and lookup provenance; outside values are omitted everywhere", async () => {
    const parsed = fixture();
    parsed.bundle = { ...parsed.bundle, target: "dev", mode: "development" } as ParsedBundleConfig["bundle"];
    parsed.variables = {
      ordinary: { default: "repository", value: "repository" },
      target: { default: "target-value", value: "target-value" },
      lookup: { lookup: { warehouse: "shared" }, value: "warehouse-id" },
      external: { default: "default", value: "PRIVATE-OUTSIDE" },
      noDefault: { value: "PRIVATE-NODEFAULT" },
      complex: { type: "complex", value: { token: "PRIVATE-NESTED" } },
    };
    parsed.targets = { dev: { variables: { target: "target-value" } } };
    parsed.workspace = { host: "https://private-host", current_user: { userName: "private-user@example.org", short_name: "private-user", displayName: "Private Person" } };
    parsed.resources!.schemas = { d: { catalog_name: "main", name: "dev_private-user_daily" } };
    parsed.resources!.jobs = { daily: { name: "[dev private-user] PRIVATE-OUTSIDE-PRIVATE-NODEFAULT-PRIVATE-NESTED", tasks: [] } };
    const markdown = await report(parsed, [{ ...problem(), detail: "PRIVATE-OUTSIDE https://private-host Private Person" }], { ...context, structuralPreview: false, targetName: "dev", targetLabel: "dev" });
    expect(markdown).toContain("| Mode | development |");
    expect(markdown).toContain("| ordinary | repository | default |");
    expect(markdown).toContain("| target | target-value | target |");
    expect(markdown).toContain("| lookup | warehouse-id | lookup |");
    expect(markdown).toContain("outside repository; value omitted");
    expect(markdown).not.toMatch(/PRIVATE-|private-host|private-user|Private Person/);
  });

  test("preview values stay as written, including expressions, and no workspace is implied", async () => {
    const parsed = fixture();
    parsed.variables = { derived: { default: "${var.schema}_suffix" } };
    const markdown = await report(parsed);
    expect(markdown).toContain("${var.schema}");
    expect(markdown).toContain("as written; unresolved");
    expect(markdown).toContain("without a login");
  });

  test("variable consumers include target-only declarations and other variables, labelled as written", async () => {
    const parsed = fixture();
    parsed.variables = { v: { default: "value", value: "value" }, derived: { default: "${var.v}-suffix" } };
    parsed.targets = { dev: { resources: { jobs: { daily: { name: "${var.v}" } } } } };
    const markdown = await report(parsed, [], { ...context, structuralPreview: false, targetName: "dev", targetLabel: "dev" });
    expect(markdown).toContain("Used by (as written)");
    expect(markdown).toContain("jobs.daily (dev override), variable derived");
  });

  test("a one-character outside value is omitted without rewriting Markdown or diagram identifiers", async () => {
    const parsed = fixture();
    parsed.variables = { outside: { default: "old", value: "r" } };
    const markdown = await report(parsed, [], { ...context, structuralPreview: false, targetName: "dev" });
    expect(markdown).toContain("```mermaid\nflowchart LR\n");
    expect(markdown).toContain("classDef resource");
    expect(markdown).toContain("| Variable | Value | Source |");
  });

  test("huge clean inventories lose the picture before folded rows, with an explicit omission", async () => {
    const parsed = fixture();
    parsed.resources!.jobs = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`j${i}`, { name: "a".repeat(2000), tasks: [] }]));
    const markdown = await report(parsed, [problem()]);
    expect(markdown.length).toBeLessThanOrEqual(REVIEW_REPORT_MAX_CHARACTERS);
    expect(markdown).toContain("the bundle diagram, the folded rows with no problems");
    expect(markdown).toContain("Full explanation 1");
  });

  test("thousands of broken rows and very long metadata still produce complete Markdown under the cap", async () => {
    const parsed = fixture();
    parsed.resources!.jobs = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`j${i}`, { name: "a".repeat(200), tasks: [] }]));
    const issues = Array.from({ length: 600 }, (_, i) => ({ ...problem(i), taskId: `resources.jobs.j${i}.tasks.x`, resourceId: `resources.jobs.j${i}`, detail: "detail".repeat(1000) }));
    const markdown = await report(parsed, issues);
    expect(markdown.length).toBeLessThanOrEqual(REVIEW_REPORT_MAX_CHARACTERS);
    expect(markdown).toContain("Left out");
    expect(markdown).toContain("### Not checked");
    const enormous = await report({ ...parsed, bundle: { name: "x".repeat(80_000) } });
    expect(enormous.length).toBeLessThanOrEqual(REVIEW_REPORT_MAX_CHARACTERS);
    expect(enormous).toContain("Left out");
  });

  test("resource names cannot inject Markdown rows, HTML or Mermaid syntax", async () => {
    const parsed = fixture();
    parsed.resources!.jobs = { 'bad"]\nend\nclick x "https://evil"': { name: "<details>|[link](https://evil)\n## hi", tasks: [] } };
    const markdown = await report(parsed);
    expect(markdown).toContain("&lt;details&gt;");
    expect(markdown).not.toContain('\nclick x');
    expect(markdown).not.toContain('[link](https://evil)');
  });
});

describe("copied report locations", () => {
  test.each([
    ["/repo/a/same.yml", "/repo", "a/same.yml:7"],
    ["/repo/b/same.yml", "/repo", "b/same.yml:7"],
    ["/outside/same.yml", "/repo", "/outside/same.yml:7"],
    ["/repo-other/same.yml", "/repo", "/repo-other/same.yml:7"],
    ["C:\\repo\\a\\same.yml", "C:\\repo", "a/same.yml:7"],
  ])("%s from %s", (file, root, expected) => expect(reportLocation(file, 7, root)).toBe(expected));

  test("bundle, job and pipeline distinguish duplicate basenames and preserve outside locations", async () => {
    const parsed = fixture();
    const graph = await extractBundleGraph(parsed);
    const issues = ["/repo/a/same.yml", "/repo/b/same.yml", "/outside/same.yml"].map((file, i) => ({ ...problem(i + 1), file }));
    const bundle = bundleReviewReport(parsed, graph, issues, context);
    const job = jobReviewReport(parsed, graph, "daily", issues, context);
    const pipelineIssues = issues.map(issue => ({ ...issue, taskId: undefined, resourceId: "resources.pipelines.ingest" }));
    const pipeline = pipelineReviewSummary(buildPipelineView(graph, parsed, "ingest", pipelineIssues)!, { bundleName: "sales", targetLabel: "dev", bundleRoot: "/repo" });
    for (const markdown of [bundle, job, pipeline]) {
      expect(markdown).toContain("a/same.yml:1"); expect(markdown).toContain("b/same.yml:2"); expect(markdown).toContain("/outside/same.yml:3");
    }
  });
});
