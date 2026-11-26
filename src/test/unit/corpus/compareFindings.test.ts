import { describe, expect, test } from "@jest/globals";
import { compareReports, comparisonMarkdown, hasChanges, type CorpusFinding, type CorpusReport } from "../../corpus/compareFindings.js";

const finding = (overrides: Partial<CorpusFinding> = {}): CorpusFinding => ({
  severity: "error",
  code: "missing_file",
  message: "File not found: ./a.py",
  file: "b/databricks.yml",
  line: 3,
  ...overrides,
});
const report = (...bundles: Array<[string, CorpusFinding[]]>): CorpusReport => ({
  bundles: bundles.map(([path, findings]) => ({ path, validated: true, findings })),
});

describe("comparing findings on real bundles (#651)", () => {
  test("the same findings in another order are no difference", () => {
    const a = finding();
    const b = finding({ code: "widget_not_set", severity: "warning", message: "w" });
    const comparison = compareReports(report(["b", [a, b]]), report(["b", [b, a]]));
    expect(hasChanges(comparison)).toBe(false);
    expect(comparisonMarkdown(comparison, "1 folder")).toContain("**No differences.**");
  });

  test("a new, a gone and a moved finding", () => {
    const comparison = compareReports(
      report(["b", [finding(), finding({ code: "unused_parameter", severity: "info", message: "p" })]]),
      report(["b", [finding({ line: 4 }), finding({ code: "widget_not_set", severity: "warning", message: "w" })]]),
    );
    expect(comparison.appeared.map((change) => [change.finding.code, change.finding.line])).toEqual([["missing_file", 4], ["widget_not_set", 3]]);
    expect(comparison.disappeared.map((change) => [change.finding.code, change.finding.line])).toEqual([["missing_file", 3], ["unused_parameter", 3]]);
    const markdown = comparisonMarkdown(comparison, "1 folder");
    expect(markdown).toContain("| missing\\_file | 1 | 1 |");
    expect(markdown).toContain("corpus-change-expected");
  });

  test("two identical findings against one is a difference", () => {
    const comparison = compareReports(report(["b", [finding()]]), report(["b", [finding(), finding()]]));
    expect(comparison.appeared).toHaveLength(1);
    expect(comparison.disappeared).toHaveLength(0);
  });

  test("the same finding in another bundle is a difference", () => {
    const comparison = compareReports(report(["one", [finding()]], ["two", []]), report(["one", []], ["two", [finding()]]));
    expect([comparison.appeared.length, comparison.disappeared.length]).toEqual([1, 1]);
  });

  test("a bundle only one side found", () => {
    const comparison = compareReports(report(["one", []]), report(["one", []], ["two", []]));
    expect(hasChanges(comparison)).toBe(true);
    expect(comparisonMarkdown(comparison, "x")).toContain("Bundles found only by this pull request: two.");
  });

  test("text from a bundle can't make links, HTML, mentions or break the table", () => {
    const comparison = compareReports(report(["b", []]), report(["b", [finding({ message: "[x](https://e.test) <img> @team | `c`\nnext" })]]));
    expect(comparisonMarkdown(comparison, "x")).toContain("\\[x\\](https://e.test) \\<img\\> \\@team \\| \\`c\\` next");
  });

  test("past five examples a code says how many more", () => {
    const many = Array.from({ length: 7 }, (_, i) => finding({ line: i }));
    expect(comparisonMarkdown(compareReports(report(["b", []]), report(["b", many])), "x")).toContain("- ...and 2 more.");
  });
});
