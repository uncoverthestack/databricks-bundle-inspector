import { describe, expect, test } from "@jest/globals";
import { docsDate, runtimeReleasesFromDocs } from "../../integration/runtimeDocs.js";

// The weekly runtime dates check (#485) reads the docs pages with this; tested here offline,
// on HTML written the way the pages write it (no closing row or cell tags, each table twice).
const supported = `<p>x</p><table><thead><tr><th><p>Version<th><p>Variants<th><p>Apache Spark<!-- --> version<th><p>Release date<th><p>End-of-support date<tbody><tr><td><p>19<td><p>Databricks Runtime 19<td><p>4.3.0<td><p>July 23, 2026<td><p>Determined at LTS transition<tr><td><p>18 LTS<td><p>Databricks Runtime 18 LTS<td><p>4.1.0<td><p>June 10, 2026<td><p>June 10, 2029</table>`;
const eos = `<table><thead><tr><th><p>Version<th><p>Apache Spark<!-- --> version<th><p>Release date<th><p>End-of-support date<th><p>End-of-life date<tbody><tr><td><p>18.2<td><p>4.1.0<td><p>May 5, 2026<td><p>Nov 5, 2026<td><p>Not yet announced<tbody><tr><td><p>13.3 LTS<td><p>3.4.1<td><p>Aug 22, 2023<td><p>Aug 22, 2026<td><p>Mar 1, 2027</table>`;
const mlTable = `<table><thead><tr><th><p>Databricks Runtime ML version<th><p>MLflow version<tbody><tr><td><p>19<td><p>3.12.0</table>`;

describe("reading the Databricks Runtime docs pages (#485)", () => {
  test("dates in full and short month names", () => {
    expect(docsDate("June 10, 2029")).toBe("2029-06-10");
    expect(docsDate("Sep 11, 2026")).toBe("2026-09-11");
    expect(docsDate("Sept. 1, 2026")).toBe("2026-09-01");
    expect(docsDate("Determined at LTS transition")).toBeUndefined();
    expect(docsDate("Not yet announced")).toBeUndefined();
  });

  test("the supported list, twice as on the page, and tables without dates ignored", () => {
    expect(runtimeReleasesFromDocs(supported + supported + mlTable)).toEqual({
      "19": { lts: false },
      "18": { lts: true, endOfSupport: "2029-06-10" },
    });
  });

  test("the end-of-support list, with an end-of-life date once one is announced", () => {
    expect(runtimeReleasesFromDocs(eos)).toEqual({
      "18.2": { lts: false, endOfSupport: "2026-11-05" },
      "13.3": { lts: true, endOfSupport: "2026-08-22", endOfLife: "2027-03-01" },
    });
  });
});
