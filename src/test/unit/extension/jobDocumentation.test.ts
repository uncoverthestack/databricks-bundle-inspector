import { describe, expect, test } from "@jest/globals";
import { collectNativeDocumentationSignals } from "../../../bundle/documentationSignals.js";
import { extractBundleGraph } from "../../../bundle/graph/bundleGraph.js";
import type { ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import {
  buildJobDocumentation,
  renderJobDocumentationMarkdown,
} from "../../../bundle/jobDocumentation.js";

describe("job documentation", () => {
  test("renders native purpose, dbi task notes, and execution flow", async () => {
    const parsedBundle: ParsedBundleConfig = {
      bundle: { name: "demo-bundle" },
      resources: {
        jobs: {
          daily_ingest: {
            name: "Daily ingest",
            description: "Refreshes staging data for reporting.",
            parameters: [{ name: "env", default: "dev" }],
            tasks: [
              {
                task_key: "load_source",
                description: "Loads source rows.",
                notebook_task: { notebook_path: "./notebooks/load.py" },
              },
              {
                task_key: "validate_source",
                depends_on: [{ task_key: "load_source" }],
                sql_task: {
                  file: { path: "./queries/validate.sql" },
                  warehouse_id: "warehouse_id",
                },
              },
            ],
          },
        },
      },
    };
    const graph = await extractBundleGraph(parsedBundle);
    const signals = [
      ...collectNativeDocumentationSignals(parsedBundle),
      {
        scope: "task" as const,
        source: "dbi_comment" as const,
        jobKey: "daily_ingest",
        taskKey: "validate_source",
        text: "Blocks publishing if the row count looks wrong.",
        yamlPath: "resources.jobs.daily_ingest.tasks.validate_source",
      },
    ];

    const doc = buildJobDocumentation(
      parsedBundle,
      graph,
      "daily_ingest",
      signals,
      [],
    );
    const markdown = renderJobDocumentationMarkdown(doc);

    expect(markdown).toContain("# Job: Daily ingest");
    expect(markdown).toContain("Refreshes staging data for reporting.");
    expect(markdown).toContain("### validate_source");
    expect(markdown).toContain("Blocks publishing if the row count looks wrong.");
    expect(markdown).toContain("flowchart LR");
    expect(markdown).toContain("`validate_source` depends on `load_source`");
  });

  test("omits inspector issues from generated markdown", async () => {
    const parsedBundle: ParsedBundleConfig = {
      bundle: { name: "demo-bundle" },
      resources: {
        jobs: {
          config_job: {
            name: "config_job",
            tasks: [
              {
                task_key: "load",
                notebook_task: { notebook_path: "./load.py" },
              },
            ],
          },
        },
      },
    };
    const graph = await extractBundleGraph(parsedBundle);
    const doc = buildJobDocumentation(
      parsedBundle,
      graph,
      "config_job",
      [],
      [
        {
          id: "validation:0:0",
          severity: "warning",
          kind: "unknown_or_deprecated_field",
          title: "Unknown or deprecated field",
          detail: "desription",
          fixHint:
            "Remove the field or update it to a Databricks Bundle field supported by your CLI version.",
        },
      ],
    );
    const markdown = renderJobDocumentationMarkdown(doc);

    expect(markdown).not.toContain("## Known Issues");
    expect(markdown).not.toContain("| Issues |");
    expect(markdown).not.toContain("Unknown or deprecated field");
    expect(markdown).not.toContain(
      "Databricks CLI reported bundle diagnostics",
    );
  });
});
