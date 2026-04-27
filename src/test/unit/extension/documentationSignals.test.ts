import { describe, expect, test } from "@jest/globals";
import {
  collectNativeDocumentationSignals,
  parseDbiCommentSignals,
} from "../../../bundle/documentationSignals.js";
import type { ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";

describe("parseDbiCommentSignals", () => {
  test("attaches dbi comments to jobs and tasks", () => {
    const signals = parseDbiCommentSignals(
      "/bundle/resources/job.yml",
      [
        "resources:",
        "  jobs:",
        "    # dbi: Runs the daily ingest workflow.",
        "    daily_ingest:",
        "      name: Daily ingest",
        "      tasks:",
        "        # dbi: Loads source files into staging.",
        "        - task_key: load_source",
        "          notebook_task:",
        "            notebook_path: ./notebooks/load.py",
        "        - task_key: validate_source # dbi: Checks row counts before publish.",
      ].join("\n"),
    );

    expect(signals).toEqual([
      expect.objectContaining({
        scope: "job",
        source: "dbi_comment",
        jobKey: "daily_ingest",
        text: "Runs the daily ingest workflow.",
        line: 3,
      }),
      expect.objectContaining({
        scope: "task",
        source: "dbi_comment",
        jobKey: "daily_ingest",
        taskKey: "load_source",
        text: "Loads source files into staging.",
        line: 7,
      }),
      expect.objectContaining({
        scope: "task",
        source: "dbi_comment",
        jobKey: "daily_ingest",
        taskKey: "validate_source",
        text: "Checks row counts before publish.",
        line: 11,
      }),
    ]);
  });
});

describe("collectNativeDocumentationSignals", () => {
  test("collects native job and task descriptions", () => {
    const parsedBundle: ParsedBundleConfig = {
      bundle: { name: "demo" },
      resources: {
        jobs: {
          daily_ingest: {
            description: "Refreshes staging data.",
            tasks: [
              {
                task_key: "load_source",
                description: "Loads the source dataset.",
              },
            ],
          },
        },
      },
    };

    expect(collectNativeDocumentationSignals(parsedBundle)).toEqual([
      expect.objectContaining({
        scope: "job",
        source: "native_description",
        jobKey: "daily_ingest",
        text: "Refreshes staging data.",
      }),
      expect.objectContaining({
        scope: "task",
        source: "native_description",
        jobKey: "daily_ingest",
        taskKey: "load_source",
        text: "Loads the source dataset.",
      }),
    ]);
  });
});
