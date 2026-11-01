import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MODELLED_RESOURCE_GROUPS } from "../../../bundle/graph/bundleGraph.js";

const supportedDoc = readFileSync(path.resolve(__dirname, "../../../../docs/supported-resources.md"), "utf8");

/** The groups the table links to its Databricks reference, written as [`group`](...resources#anchor). */
const documented = [...supportedDoc.matchAll(/\[`([a-z_]+)`\]\(https:\/\/docs\.databricks\.com\/[^)]*\/bundles\/resources#/g)].map(
  (match) => match[1]!,
);

describe("resource groups and docs/supported-resources.md", () => {
  test("the table names every modelled resource group exactly once, and nothing else", () => {
    expect([...documented].sort()).toEqual([...MODELLED_RESOURCE_GROUPS].sort());
  });
});
