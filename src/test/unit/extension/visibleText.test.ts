import { describe, expect, test } from "@jest/globals";
import { escapeMarkdown } from "../../../bundle/markdownText.js";
import { withVisibleDirectionControls } from "../../../bundle/visibleText.js";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

// In Chrome, "./src/" + U+202E + "yp.tset" + U+202C is shown as "./src/test.py".
const DISGUISED = "./src/‮yp.tset‬";

describe("withVisibleDirectionControls", () => {
  test("shows each override, embedding and isolate as a marker", () => {
    expect(withVisibleDirectionControls(DISGUISED)).toBe("./src/[U+202E]yp.tset[U+202C]");
    const all = "‪‫‬‭‮⁦⁧⁨⁩";
    expect(withVisibleDirectionControls(all)).toBe(
      "[U+202A][U+202B][U+202C][U+202D][U+202E][U+2066][U+2067][U+2068][U+2069]",
    );
  });

  test("leaves right-to-left letters, the direction marks and plain text alone", () => {
    for (const text of ["שלום", "مرحبا", "a‎b‏c", "notebooks/load.py", ""]) {
      expect(withVisibleDirectionControls(text)).toBe(text);
    }
  });

  test("Markdown reports show the markers", () => {
    expect(escapeMarkdown(`job ${DISGUISED}`)).toBe("job ./src/\\[U+202E\\]yp.tset\\[U+202C\\]");
  });
});

describe("findings show a disguised name as it is", () => {
  test("a missing notebook's finding names it with the markers", async () => {
    const root = "/workspace/bidi";
    const config = {
      bundle: { name: "bidi" },
      resources: { jobs: { j: { name: "j", tasks: [{ task_key: "t", notebook_task: { notebook_path: DISGUISED } }] } } },
    } as unknown as ParsedBundleConfig;
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, root));
    const issues = buildInspectorIssues(graph, config, [], root);
    const text = issues.flatMap((issue) => [issue.title, issue.detail ?? "", issue.fixHint ?? ""]).join("\n");
    expect(text).toContain("[U+202E]yp.tset[U+202C]");
    expect(text).not.toMatch(/[‪-‮⁦-⁩]/);
  });
});
