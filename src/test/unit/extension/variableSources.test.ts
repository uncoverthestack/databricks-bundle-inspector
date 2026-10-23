import { describe, expect, test } from "@jest/globals";
import { findVariableSources } from "../../../bundle/variableSources.js";

const BUNDLE_FILE = "/bundle/databricks.yml";
const RESOURCE_FILE = "/bundle/resources/core.yml";
const LATER_FILE = "/bundle/resources/zz.yml";

const file = (path: string, lines: string[]) => ({ file: path, text: lines.join("\n") });

describe("findVariableSources", () => {
  test("points a definition at its default value, and a target's shorthand override at its value", () => {
    const sources = findVariableSources([
      file(BUNDLE_FILE, [
        "variables:", //                               1
        "  job_schedule_cron:", //                     2
        "    description: Default cron schedule", //   3
        '    default: "0 0 */6 * * ?"', //             4
        "targets:", //                                 5
        "  qa:", //                                    6
        "    variables:", //                           7
        '      job_schedule_cron: "0 */10 * * * ?"', // 8
      ]),
    ]);
    expect(sources.job_schedule_cron).toEqual({
      definition: { file: BUNDLE_FILE, line: 4, column: 14 },
      targets: { qa: { file: BUNDLE_FILE, line: 8, column: 26 } },
    });
  });

  test("points at a lookup, at value: when the config sets it, and at a target's full-form default", () => {
    const sources = findVariableSources([
      file(BUNDLE_FILE, [
        "variables:", //                    1
        "  warehouse_id:", //               2
        "    lookup:", //                   3
        "      warehouse: Shared SQL", //   4
        "  foo:", //                        5
        "    value: bar", //                6
        "targets:", //                      7
        "  prod:", //                       8
        "    variables:", //                9
        "      warehouse_id:", //           10
        "        default: abc123", //       11
      ]),
    ]);
    expect(sources.warehouse_id?.definition?.line).toBe(4);
    expect(sources.foo?.definition?.line).toBe(6);
    expect(sources.warehouse_id?.targets.prod?.line).toBe(11);
  });

  test("points a variable with no value at its name", () => {
    const sources = findVariableSources([
      file(BUNDLE_FILE, ["variables:", "  bare:", "  described:", "    description: set me", "  next: {}"]),
    ]);
    expect(sources.bare?.definition).toEqual({ file: BUNDLE_FILE, line: 2, column: 3 });
    expect(sources.described?.definition?.line).toBe(4);
  });

  test("keeps a target that sets a variable the bundle never defines", () => {
    const sources = findVariableSources([
      file(BUNDLE_FILE, ["targets:", "  dev:", "    variables:", "      only_here: x"]),
    ]);
    expect(sources.only_here).toEqual({
      targets: { dev: { file: BUNDLE_FILE, line: 4, column: 18 } },
    });
  });

  test("a later file wins, as the CLI loads databricks.yml first and then the include files in order", () => {
    const sources = findVariableSources([
      file(BUNDLE_FILE, ["variables:", "  catalog:", "    default: from_bundle_file", "targets:", "  dev:", "    variables:", "      catalog: dev_bundle_file"]),
      file(RESOURCE_FILE, ["variables:", "  catalog:", "    default: from_include", "  schema:", "    default: raw"]),
      file(LATER_FILE, ["variables:", "  catalog:", "    default: from_later_include", "targets:", "  dev:", "    variables:", "      catalog: dev_later"]),
    ]);
    expect(sources.catalog?.definition).toEqual({ file: LATER_FILE, line: 3, column: 14 });
    expect(sources.catalog?.targets.dev).toEqual({ file: LATER_FILE, line: 7, column: 16 });
    expect(sources.schema?.definition).toEqual({ file: RESOURCE_FILE, line: 5, column: 14 });
  });

  test("follows an alias to the line that names it", () => {
    const sources = findVariableSources([
      file(BUNDLE_FILE, [
        "variables:", //                    1
        "  catalog:", //                    2
        "    default: &cat main_cat", //    3
        "targets:", //                      4
        "  dev:", //                        5
        "    variables:", //                6
        "      catalog: *cat", //           7
      ]),
    ]);
    expect(sources.catalog?.targets.dev?.line).toBe(7);
  });

  test("follows merge keys: a later merge wins, and the target's own keys win wherever they are", () => {
    // Rules from the CLI's acceptance tests yaml_anchors/target_variable_precedence
    // (<<: [*a, *b] gives from-b) and target_variable_shorthand_alias.
    const sources = findVariableSources([
      file(BUNDLE_FILE, [
        "definitions:", //                 1
        "  a: &a", //                      2
        "    x: from-a", //                3
        "    size: small", //              4
        "  b: &b", //                      5
        "    x: from-b", //                6
        "targets:", //                     7
        "  dev:", //                       8
        "    variables:", //               9
        "      size: large", //            10
        "      <<: [*a, *b]", //           11
      ]),
    ]);
    expect(sources.x?.targets.dev?.line).toBe(6);
    expect(sources.size?.targets.dev?.line).toBe(10);
  });

  test("follows a merge or alias that brings in a whole target or its variables", () => {
    const sources = findVariableSources([
      file(BUNDLE_FILE, [
        "definitions:", //                   1
        "  target_defaults: &td", //         2
        "    variables:", //                 3
        "      x: overridden", //            4
        "  prod_vars: &pv", //               5
        "    y: prod_y", //                  6
        "targets:", //                       7
        "  dev:", //                         8
        "    <<: *td", //                    9
        "  prod:", //                        10
        "    variables: *pv", //             11
      ]),
    ]);
    expect(sources.x?.targets.dev?.line).toBe(4);
    expect(sources.y?.targets.prod?.line).toBe(6);
  });

  test("an alias reads the last anchor of its name written before it", () => {
    const sources = findVariableSources([
      file(BUNDLE_FILE, [
        "definitions:", //             1
        "  first: &v", //              2
        "    x: first", //             3
        "  second: &v", //             4
        "    x: second", //            5
        "targets:", //                 6
        "  dev:", //                   7
        "    variables: *v", //        8
        "definitions_after:", //       9
        "  third: &v", //              10
        "    x: third", //             11
      ]),
    ]);
    expect(sources.x?.targets.dev?.line).toBe(5);
  });

  test("a target's mapping with a key that isn't a variable setting is the value itself", () => {
    const sources = findVariableSources([
      file(BUNDLE_FILE, [
        "targets:", //                                  1
        "  t:", //                                      2
        "    variables:", //                            3
        "      shorthand_map: {a: x}", //               4
        "      mixed: {default: d, a: y}", //           5
        "      full:", //                               6
        "        description: d", //                    7
        "        default: {a: z}", //                   8
      ]),
    ]);
    expect(sources.shorthand_map?.targets.t?.line).toBe(4);
    expect(sources.mixed?.targets.t).toEqual({ file: BUNDLE_FILE, line: 5, column: 14 });
    expect(sources.full?.targets.t?.line).toBe(8);
  });

  test("keeps the last of a repeated key, as the CLI does", () => {
    const sources = findVariableSources([
      file(BUNDLE_FILE, ["targets:", "  dev:", "    variables:", "      x:", "        default: first", "        default: second"]),
    ]);
    expect(sources.x?.targets.dev?.line).toBe(6);
  });

  test("ignores keys named variables anywhere but the top level and a target, and files that don't parse", () => {
    const sources = findVariableSources([
      file(RESOURCE_FILE, [
        "resources:",
        "  jobs:",
        "    etl:",
        "      variables:",
        "        not_a_bundle_variable: x",
        "targets:",
        "  dev:",
        "    resources:",
        "      jobs:",
        "        etl:",
        "          variables:",
        "            also_not: y",
      ]),
      file(LATER_FILE, ["variables:", "  broken: [unclosed"]),
    ]);
    expect(sources).toEqual({});
  });
});
