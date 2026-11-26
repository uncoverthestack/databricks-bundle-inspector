import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

// P03/P04/P05: workspace deployment, file presence, pipeline updates and working controls
// were checked live on CLI v1.28.0 (2026-11-25). These regressions run locally.
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dbi-pipeline-sources-"));
  await mkdir(path.join(root, "sql"));
  await writeFile(path.join(root, "sql", "anchor.sql"), "CREATE MATERIALIZED VIEW anchor AS SELECT 1 AS id;\n");
});
afterEach(async () => { jest.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const configFor = (selected = "probe", sync?: ParsedBundleConfig["sync"]) => ({
  bundle: { name: "source_coverage" }, ...(sync ? { sync } : {}),
  resources: {
    pipelines: { p: { name: "p", catalog: "main", schema: "sales", serverless: true, libraries: [{ glob: { include: "./sql/**" } }] } },
    jobs: { j: { name: "j", tasks: [{ task_key: "refresh", pipeline_task: { pipeline_id: "${resources.pipelines.p.id}", refresh_selection: [selected] } }] } },
  },
} as unknown as ParsedBundleConfig);
const graphFor = async (config: ParsedBundleConfig) => {
  await writeFile(path.join(root, "databricks.yml"), stringify(config));
  return extractBundleGraph(config, root);
};
const inspect = async (config: ParsedBundleConfig) => {
  const graph = await enrichGraphWithFileContent(await graphFor(config));
  return { graph, pipeline: graph.nodes.find(n => n.id === "resources.pipelines.p")!, issues: buildInspectorIssues(graph, config, [], root) };
};
const names = (found: Awaited<ReturnType<typeof inspect>>) => found.pipeline.pipelineDataFlow?.nodes.map(n => n.name) ?? [];
const selections = (found: Awaited<ReturnType<typeof inspect>>) => found.issues.filter(i => i.kind === "pipeline_selection_not_found");
const probe = "CREATE MATERIALIZED VIEW probe AS SELECT * FROM main.private.input;\n";

describe("hidden SQL sources that deploy uploads", () => {
  test("a hidden SQL file contributes its table, read and valid selection", async () => {
    await writeFile(path.join(root, "sql", ".probe.sql"), probe);
    const found = await inspect(configFor());
    expect(names(found)).toEqual(expect.arrayContaining(["probe", "main.private.input"]));
    expect(selections(found)).toEqual([]);
    expect(found.pipeline.pipelineDataFlow?.sqlFiles).toBe(2);
  });
  test("a glob containing only a hidden SQL file is not a missing source", async () => {
    await rm(path.join(root, "sql", "anchor.sql"));
    await writeFile(path.join(root, "sql", ".probe.sql"), probe);
    const found = await inspect(configFor());
    expect(names(found)).toContain("probe");
    expect(found.issues.filter(i => i.kind === "missing_pipeline_source")).toEqual([]);
    expect(selections(found)).toEqual([]);
  });
  test("a hidden subfolder is traversed", async () => {
    await mkdir(path.join(root, "sql", ".hidden"));
    await writeFile(path.join(root, "sql", ".hidden", "probe.sql"), probe);
    expect(names(await inspect(configFor()))).toContain("probe");
  });
  test("hidden file secrets use the same source set as lineage", async () => {
    await writeFile(path.join(root, "sql", ".probe.sql"), "CREATE MATERIALIZED VIEW probe AS SELECT secret('scope', 'key') AS token;");
    const found = await inspect(configFor());
    expect(found.graph.edges.some(e => e.source === "resources.pipelines.p" && e.data?.file === path.join(root, "sql", ".probe.sql"))).toBe(true);
  });
});

describe("only sources included in the deploy inform pipeline checks", () => {
  test.each(["sync.exclude", ".gitignore"])("%s removes the excluded definition and makes its selection warn", async (rule) => {
    await writeFile(path.join(root, "sql", "probe.sql"), probe);
    if (rule === ".gitignore") await writeFile(path.join(root, ".gitignore"), "sql/probe.sql\n");
    const found = await inspect(configFor("probe", rule === "sync.exclude" ? { exclude: ["sql/probe.sql"] } : undefined));
    expect(names(found)).toContain("anchor");
    expect(names(found)).not.toContain("probe");
    expect(names(found)).not.toContain("main.private.input");
    expect(selections(found)).toHaveLength(1);
    expect(found.pipeline.pipelineDataFlow?.incomplete).not.toBe(true);
  });
  test("restoring upload of the file restores its valid selection", async () => {
    await writeFile(path.join(root, "sql", "probe.sql"), probe);
    expect(selections(await inspect(configFor("probe", { exclude: ["sql/probe.sql"] })))).toHaveLength(1);
    expect(selections(await inspect(configFor()))).toEqual([]);
  });
  test("sync.include restores a gitignored SQL file", async () => {
    await writeFile(path.join(root, "sql", "probe.sql"), probe);
    await writeFile(path.join(root, ".gitignore"), "sql/probe.sql\n");
    const found = await inspect(configFor("probe", { include: ["sql/probe.sql"] }));
    expect(names(found)).toContain("probe");
    expect(selections(found)).toEqual([]);
  });
  test("sync.include can restore a descendant of a gitignored folder", async () => {
    await mkdir(path.join(root, "sql", "ignored"));
    await writeFile(path.join(root, "sql", "ignored", "probe.sql"), probe);
    await writeFile(path.join(root, ".gitignore"), "sql/ignored/\n");
    const found = await inspect(configFor("probe", { include: ["sql/ignored/probe.sql"] }));
    expect(names(found)).toContain("probe");
    expect(selections(found)).toEqual([]);
  });
  test("sync.exclude still wins over sync.include", async () => {
    await writeFile(path.join(root, "sql", "probe.sql"), probe);
    const found = await inspect(configFor("probe", { include: ["sql/probe.sql"], exclude: ["sql/probe.sql"] }));
    expect(names(found)).not.toContain("probe");
    expect(selections(found)).toHaveLength(1);
  });
  test("excluded secrets are not added as pipeline reads", async () => {
    await writeFile(path.join(root, "sql", "probe.sql"), "CREATE MATERIALIZED VIEW probe AS SELECT secret('scope', 'key') AS token;");
    const found = await inspect(configFor("anchor", { exclude: ["sql/probe.sql"] }));
    expect(found.graph.edges.some(e => e.source === "resources.pipelines.p" && e.data?.file === path.join(root, "sql", "probe.sql"))).toBe(false);
  });
  test("excluded explicit file libraries are not used for lineage", async () => {
    await writeFile(path.join(root, "sql", "probe.sql"), probe);
    const config = configFor("probe", { exclude: ["sql/probe.sql"] });
    (config.resources!.pipelines!.p as any).libraries = [{ file: { path: "./sql/probe.sql" } }];
    const found = await inspect(config);
    expect(names(found)).not.toContain("probe");
    expect(found.issues.some(i => i.kind === "excluded_from_sync")).toBe(true);
  });
  test("excluded files do not use up the source scan limit", async () => {
    for (let i = 0; i < 201; i++) await writeFile(path.join(root, "sql", `excluded${i}.sql`), `CREATE MATERIALIZED VIEW skip${i} AS SELECT 1;`);
    const found = await inspect(configFor("missing", { exclude: ["sql/excluded*.sql"] }));
    expect(found.pipeline.pipelineDataFlow?.sqlFiles).toBe(1);
    expect(found.pipeline.pipelineDataFlow?.incomplete).not.toBe(true);
    expect(selections(found)).toHaveLength(1);
  });
  test("the selected target's default sync root still filters sources", async () => {
    await writeFile(path.join(root, "sql", "probe.sql"), probe);
    const config = configFor("probe", { paths: ["."], exclude: ["sql/probe.sql"] });
    config.bundle = { ...config.bundle, target: "prod" };
    expect(names(await inspect(config))).not.toContain("probe");
  });
  test("external sync roots retain the documented limitation", async () => {
    await writeFile(path.join(root, "sql", "probe.sql"), probe);
    const found = await inspect(configFor("probe", { paths: [".", "../common"], exclude: ["sql/probe.sql"] }));
    expect(found.graph.sourceUpload).toBeUndefined();
    expect(names(found)).toContain("probe");
  });
});

describe("failed source discovery is visible and incomplete", () => {
  test.each(["subfolder", "root"])("an unreadable %s produces an error, with no missing-table advice", async (kind) => {
    const denied = kind === "root" ? path.join(root, "sql") : path.join(root, "sql", "denied");
    await mkdir(denied, { recursive: true });
    await writeFile(path.join(denied, "probe.sql"), probe);
    const config = configFor();
    const graph = await graphFor(config);
    const original = fs.readdirSync;
    jest.spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]) === denied) throw Object.assign(new Error("private exception contents"), { code: "EACCES" });
      return original(...args);
    }) as typeof fs.readdirSync);
    const enriched = await enrichGraphWithFileContent(graph);
    const found = { graph: enriched, pipeline: enriched.nodes.find(n => n.id === "resources.pipelines.p")!, issues: buildInspectorIssues(enriched, config, [], root) };
    expect(found.pipeline.pipelineDataFlow?.incomplete).toBe(true);
    const failures = found.issues.filter(i => i.kind === "file_scan_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ severity: "error", resourceId: "resources.pipelines.p", file: path.join(root, "databricks.yml") });
    expect(failures[0]!.detail).toContain(denied);
    expect(JSON.stringify(failures)).not.toContain("private exception contents");
    expect(selections(found)).toEqual([]);
  });
  test("near miss (file_scan_failed): an excluded unreadable directory does not produce a scan error", async () => {
    const denied = path.join(root, "sql", "denied");
    await mkdir(denied);
    const config = configFor("anchor", { exclude: ["sql/denied"] });
    const graph = await graphFor(config);
    const original = fs.readdirSync;
    jest.spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]) === denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return original(...args);
    }) as typeof fs.readdirSync);
    const enriched = await enrichGraphWithFileContent(graph);
    expect(buildInspectorIssues(enriched, config, [], root).filter(i => i.kind === "file_scan_failed")).toEqual([]);
    expect(enriched.nodes.find(n => n.id === "resources.pipelines.p")?.pipelineDataFlow?.incomplete).not.toBe(true);
  });
  test("a regular-file control still reports a truly missing selection", async () => {
    const found = await inspect(configFor("missing"));
    expect(selections(found)).toHaveLength(1);
    expect(found.issues.filter(i => i.kind === "file_scan_failed")).toEqual([]);
  });
});

test("an unreadable glob root is not described as an empty or missing folder", async () => {
  const denied = path.join(root, "sql");
  const original = fs.readdirSync;
  jest.spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
    if (String(args[0]) === denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return original(...args);
  }) as typeof fs.readdirSync);
  const found = await inspect(configFor());
  expect(found.pipeline.pipelineDataFlow?.incomplete).toBe(true);
  expect(found.issues.map(issue => issue.kind)).toEqual(["file_scan_failed"]);
});

test("a gitignored unreadable folder without a reinclude does not create a false error", async () => {
  const denied = path.join(root, "sql", "ignored");
  await mkdir(denied);
  await writeFile(path.join(denied, "probe.sql"), probe);
  await writeFile(path.join(root, ".gitignore"), "sql/ignored/\n");
  const config = configFor("anchor");
  const graph = await graphFor(config);
  const original = fs.readdirSync;
  jest.spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
    if (String(args[0]) === denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return original(...args);
  }) as typeof fs.readdirSync);
  const enriched = await enrichGraphWithFileContent(graph);
  expect(buildInspectorIssues(enriched, config, [], root).filter(i => i.kind === "file_scan_failed")).toEqual([]);
});
