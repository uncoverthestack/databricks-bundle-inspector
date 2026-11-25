import { describe, expect, it } from "@jest/globals";
import { closestName } from "../../../bundle/closestName.js";

describe("closestName", () => {
  describe("a short name inside a long one is not a suggestion", () => {
    it.each([
      ["load_orders_bronze", ["load", "silver"]],
      ["customer_id", ["id", "region"]],
      ["start_date", ["date"]],
      ["id", ["customer_id"]],
    ])("%s with %j", (name, candidates) => {
      expect(closestName(name, candidates)).toBeUndefined();
    });
  });

  describe("likely spellings are still suggested", () => {
    it.each([
      ["schema", ["schema_name", "catalog"], "schema_name"],
      ["schema_name", ["schema", "catalog"], "schema"],
      ["Load", ["load", "silver"], "load"],
      ["run-date", ["run_date"], "run_date"],
      ["rundate", ["run_date"], "run_date"],
      ["laod", ["load", "silver"], "load"],
      ["catalgo", ["catalog", "schema"], "catalog"],
    ])("%s with %j suggests %s", (name, candidates, expected) => {
      expect(closestName(name, candidates)).toBe(expected);
    });
  });

  it("gives no hint for a very short abbreviation, the price of no wrong hints", () => {
    expect(closestName("env", ["environment"])).toBeUndefined();
  });

  it("takes a name that is exactly half of the other, and not one shorter", () => {
    expect(closestName("abcd", ["abcdwxyz"])).toBe("abcdwxyz");
    expect(closestName("abc", ["abcdwxyz"])).toBeUndefined();
  });

  it("never suggests an empty name, and suggests nothing for one", () => {
    expect(closestName("x", [""])).toBeUndefined();
    expect(closestName("load", ["", "silver"])).toBeUndefined();
    expect(closestName("", ["load"])).toBeUndefined();
    expect(closestName("-_ ", ["load"])).toBeUndefined();
  });

  it("gives the same answer whatever order the candidates come in", () => {
    const candidates = ["schema_name", "schemas", "load", "loads", "laod"];
    for (const name of ["schema", "lod", "load_orders_bronze"]) {
      expect(closestName(name, [...candidates].reverse())).toBe(closestName(name, candidates));
    }
  });

  it("finds the one close name among thousands of unrelated ones", () => {
    const candidates = Array.from({ length: 5_000 }, (_, i) => `task_${i}_${"x".repeat(i % 7)}`);
    candidates.splice(2_500, 0, "ingest_orders");
    expect(closestName("ingest_ordrs", candidates)).toBe("ingest_orders");
    // Less than half of `ingestorders`: a part of the name, not a spelling of it.
    expect(closestName("inges", candidates)).toBeUndefined();
  });
});
