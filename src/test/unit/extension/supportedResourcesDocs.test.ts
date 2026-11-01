import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MODELLED_RESOURCE_GROUPS } from "../../../bundle/graph/bundleGraph.js";

const supportedDoc = readFileSync(path.resolve(__dirname, "../../../../docs/supported-resources.md"), "utf8");

const STATUSES = ["View and checks", "Some checks", "Not checked"];

// The groups that have a view or checks today. Add a group here and to the page when it gets one.
const CHECKED_GROUPS = ["jobs", "pipelines", "secret_scopes", "clusters"];

/** Table rows after the header and separator, split into cells. */
const rows = supportedDoc
  .split("\n")
  .filter((line) => line.startsWith("| "))
  .slice(2)
  .map((line) => line.slice(2, -2).split(" | "));

/** The group a row links to its Databricks reference, written as [`group`](...resources#anchor). */
const groupOf = (cell: string) =>
  /^\[`([a-z_]+)`\]\(https:\/\/docs\.databricks\.com\/[^)]*\/bundles\/resources#[a-z_]+\)$/.exec(cell)?.[1];

describe("docs/supported-resources.md", () => {
  test("the table lists exactly the checked groups, then one row for every other group", () => {
    expect(rows.map(([first]) => groupOf(first!) ?? first)).toEqual([...CHECKED_GROUPS, "Every other resource group"]);
  });

  test("every listed group is one the inspector models", () => {
    for (const group of CHECKED_GROUPS) expect(MODELLED_RESOURCE_GROUPS).toContain(group);
  });

  test("every row has one of the documented statuses", () => {
    for (const [first, status] of rows) expect({ first, status: STATUSES.includes(status!) }).toEqual({ first, status: true });
  });
});
