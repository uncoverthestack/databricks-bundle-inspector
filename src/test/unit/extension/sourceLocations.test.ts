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
      locations.get("resources.jobs.ingest_job.tasks[0]"),
    ).toMatchObject({
      file: "/bundle/resources/job.yml",
      line: 5,
      column: 11,
    });
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

describe("parseYamlLocations follows << merge keys (#467)", () => {
  const FILE = "/bundle/databricks.yml";
  const at = (yaml: string[], path: string) => parseYamlLocations(FILE, yaml.join("\n")).get(path)?.line;

  test("a merged setting is found on its line in the anchor", () => {
    const yaml = [
      "x-task: &base", //                                   1
      "  notebook_task:", //                                2
      "    notebook_path: ./from_anchor.py", //             3
      "resources:", //                                      4
      "  jobs:", //                                         5
      "    j:", //                                          6
      "      tasks:", //                                    7
      "        - task_key: t1", //                          8
      "          <<: *base", //                             9
    ];
    expect(at(yaml, "resources.jobs.j.tasks[0].notebook_task.notebook_path")).toBe(3);
    expect(at(yaml, "resources.jobs.j.tasks[0].task_key")).toBe(8);
  });

  test("a key written in the map wins over the merged one, wherever << is", () => {
    const yaml = [
      "x: &base", //                                        1
      "  notebook_task: {notebook_path: ./a.py}", //        2
      "  timeout_seconds: 10", //                           3
      "resources:", //                                      4
      "  jobs:", //                                         5
      "    j:", //                                          6
      "      tasks:", //                                    7
      "        - notebook_task: {notebook_path: ./b.py}", // 8
      "          <<: *base", //                             9
    ];
    expect(at(yaml, "resources.jobs.j.tasks[0].notebook_task.notebook_path")).toBe(8);
    expect(at(yaml, "resources.jobs.j.tasks[0].timeout_seconds")).toBe(3);
  });

  test("in a list of anchors the later one wins, and a plain map merges too", () => {
    const yaml = [
      "a: &a {notebook_task: {notebook_path: ./a.py}}", //  1
      "b: &b {notebook_task: {notebook_path: ./b.py}}", //  2
      "resources:", //                                      3
      "  jobs:", //                                         4
      "    j:", //                                          5
      "      tasks:", //                                    6
      "        - <<: [*a, *b]", //                          7
      "        - <<: {spark_python_task: {python_file: ./c.py}}", // 8
    ];
    expect(at(yaml, "resources.jobs.j.tasks[0].notebook_task.notebook_path")).toBe(2);
    expect(at(yaml, "resources.jobs.j.tasks[1].spark_python_task.python_file")).toBe(8);
  });

  test("an anchor that merges another one is followed too", () => {
    const yaml = [
      "a: &a {notebook_task: {notebook_path: ./a.py}}", //  1
      "b: &b", //                                           2
      "  <<: *a", //                                        3
      "  timeout_seconds: 5", //                            4
      "resources:", //                                      5
      "  jobs:", //                                         6
      "    j:", //                                          7
      "      tasks:", //                                    8
      "        - <<: *b", //                                9
    ];
    expect(at(yaml, "resources.jobs.j.tasks[0].notebook_task.notebook_path")).toBe(1);
    expect(at(yaml, "resources.jobs.j.tasks[0].timeout_seconds")).toBe(4);
  });

  test("an alias that is not a map, or a broken one, adds nothing and doesn't throw", () => {
    const yaml = ["s: &s just text", "resources:", "  jobs:", "    j:", "      tasks:", "        - <<: *s", "          task_key: t"];
    expect(at(yaml, "resources.jobs.j.tasks[0].task_key")).toBe(7);
    expect(() => parseYamlLocations(FILE, "resources:\n  x:\n    <<: *missing\n")).not.toThrow();
  });
});

