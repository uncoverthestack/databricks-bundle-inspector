import { describe, test, expect } from "@jest/globals";
import { orderBySeverity, severityMeta } from "../../../webview/lib/issueSeverity.js";

describe("severityMeta", () => {
  test("gives each severity its own word and colour", () => {
    expect(severityMeta("error")).toMatchObject({ label: "Error", colorClass: "text-error" });
    expect(severityMeta("warning")).toMatchObject({ label: "Warning", colorClass: "text-warning" });
    expect(severityMeta("info")).toMatchObject({ label: "Note", colorClass: "text-info" });
    const colours = ["error", "warning", "info"].map((severity) => severityMeta(severity).colorClass);
    expect(new Set(colours).size).toBe(3);
  });

  test("gives each severity its own icon shape, as VS Code's Problems panel does, so colour is never the only difference", () => {
    expect(severityMeta("error").icon).toBe("circle-x");
    expect(severityMeta("warning").icon).toBe("triangle-alert");
    expect(severityMeta("info").icon).toBe("info");
  });

  test("shows an unknown or missing severity as a warning", () => {
    expect(severityMeta(undefined).label).toBe("Warning");
    expect(severityMeta("hint").label).toBe("Warning");
    expect(severityMeta("hint").icon).toBe("triangle-alert");
  });
});

describe("orderBySeverity", () => {
  test("puts errors first, then warnings, then notes, keeping the order within each", () => {
    const items = [
      { id: "n1", severity: "info" },
      { id: "w1", severity: "warning" },
      { id: "e1", severity: "error" },
      { id: "w2", severity: "warning" },
      { id: "e2", severity: "error" },
    ];
    expect(orderBySeverity(items).map((item) => item.id)).toEqual(["e1", "e2", "w1", "w2", "n1"]);
  });

  test("does not change the list it is given", () => {
    const items = [{ severity: "info" }, { severity: "error" }];
    orderBySeverity(items);
    expect(items[0]?.severity).toBe("info");
  });
});
