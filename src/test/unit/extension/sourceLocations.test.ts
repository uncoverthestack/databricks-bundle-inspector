import { describe, expect, test } from "@jest/globals";
import { parseYamlLocations } from "../../../bundle/sourceLocations.js";

describe("parseYamlLocations", () => {
  test("records nested map and sequence value locations", () => {
    const locations = parseYamlLocations(
      "/bundle/resources/job.yml",
      [
        "resources:",
        "  jobs:",
        "    ingest_job:",
        "      tasks:",
        "        - task_key: ingest",
        "          notebook_task:",
        "            notebook_path: notebooks/ingest.py",
      ].join("\n"),
    );

    expect(
      locations.get(
        "resources.jobs.ingest_job.tasks[0].notebook_task.notebook_path",
      ),
    ).toMatchObject({
      file: "/bundle/resources/job.yml",
      line: 7,
      column: 28,
    });
  });
});
