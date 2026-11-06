import { describe, test, expect, beforeAll } from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  extractBundleGraph,
  type ParsedBundleConfig,
} from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues, type InspectorIssue } from "../../../bundle/issues.js";
import { checkNotebookPath, isNotebookFile, notebookHeaderRuleFor, type NotebookHeaderRule } from "../../../bundle/notebookFiles.js";
import { locateFix } from "../../../bundle/quickFix.js";
import { JUPYTER_CASES } from "../../jupyterCases.js";

const bundleRoot = path.resolve(__dirname, "../../fixtures/notebook-paths");
const src = (name: string) => path.join(bundleRoot, "src", name);

const RESOURCE_FILES = [
  "resources/notebook_paths.job.yml",
  "resources/git_sourced.job.yml",
  "resources/notebook_paths.pipeline.yml",
];

// Without a target, `databricks bundle validate -o json` returns these paths unchanged
// (checked on CLI v1.17.0), so the fixture YAML stands in for the CLI output.
function fixtureConfig(): ParsedBundleConfig {
  const resources: Record<string, Record<string, unknown>> = {};
  for (const file of RESOURCE_FILES) {
    const parsed = parse(readFileSync(path.join(bundleRoot, file), "utf8")) as {
      resources: Record<string, Record<string, unknown>>;
    };
    for (const [group, entries] of Object.entries(parsed.resources)) {
      resources[group] = { ...resources[group], ...entries };
    }
  }
  return {
    bundle: { name: "notebook_paths" },
    include: RESOURCE_FILES,
    resources,
  } as ParsedBundleConfig;
}

describe("notebookHeaderRuleFor", () => {
  test.each([
    ["v0.299.2", "exact"],
    ["v1.23.0", "exact"],
    ["v1.24.0", "contains"],
    ["v1.25.3", "contains"],
    ["v2.0.0", "contains"],
    [undefined, "contains"],
    ["not a version", "contains"],
  ])("CLI %s uses the %s rule", (version, rule) => {
    expect(notebookHeaderRuleFor(version)).toBe(rule);
  });
});

describe("isNotebookFile", () => {
  // Expected values match the CLI before v1.24.0 (exact) and from it (contains); see the
  // fixture README. notebookRule.integration.test.ts checks them against the CLI itself.
  test.each([
    ["nb_ok.sql", true, true],
    ["nb_crlf.py", true, true],
    ["nb_ok.ipynb", true, true],
    ["script_nb.py", true, true],
    ["nb_plain.sql", false, false],
    ["nb_bom.py", false, true],
    ["nb_trailing_space.py", false, true],
    ["nb_extra_text.py", false, true],
    ["nb_other_comment.py", false, true],
    ["nb_marker_in_code.py", false, true],
    ["nb_marker_at_190.py", false, true],
    ["nb_marker_past_200.py", false, false],
    ["nb_old.ipynb", false, false],
    ["plain.py", false, false],
  ])("%s is a notebook: exact %s, contains %s", (file, exact, contains) => {
    expect(isNotebookFile(src(file), "exact")).toBe(exact);
    expect(isNotebookFile(src(file), "contains")).toBe(contains);
  });

  test("the newer rule is the default", () => {
    expect(isNotebookFile(src("nb_bom.py"))).toBe(true);
  });


  test.each(JUPYTER_CASES)("Jupyter file $name is a notebook: $inspector", ({ text, inspector }) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dbi-jupyter-"));
    try {
      writeFileSync(path.join(dir, "nb.ipynb"), text);
      expect(isNotebookFile(path.join(dir, "nb.ipynb"))).toBe(inspector);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is undefined for a missing file or a folder", () => {
    expect(isNotebookFile(src("does_not_exist.py"))).toBeUndefined();
    expect(isNotebookFile(path.join(bundleRoot, "src"))).toBeUndefined();
  });
});

describe("checkNotebookPath", () => {
  test("suggests the extension for a notebook path without one", () => {
    expect(checkNotebookPath("../src/nb_noext", src("nb_noext"), "notebook")).toEqual({
      kind: "missing_extension",
      suggestedPath: "../src/nb_noext.sql",
    });
  });

  test("reports nothing extra when no file with a notebook extension exists", () => {
    expect(checkNotebookPath("../src/missing", src("missing"), "notebook")).toBeUndefined();
  });
});

async function fixtureIssues(notebookRule: NotebookHeaderRule): Promise<InspectorIssue[]> {
  const config = fixtureConfig();
  const graph = await extractBundleGraph(config, bundleRoot, { notebookRule });
  return buildInspectorIssues(graph, config, [], bundleRoot).filter(
    (issue) => ["notebook_missing_extension", "not_a_notebook", "file_is_a_notebook"].includes(issue.kind),
  );
}

describe("notebook path issues on the fixture bundle, CLI before v1.24.0", () => {
  let issues: InspectorIssue[];

  beforeAll(async () => {
    issues = await fixtureIssues("exact");
  });

  function titleAt(yamlPathEnd: string): string | undefined {
    return issues.find((issue) => issue.yamlPath?.endsWith(yamlPathEnd))?.title;
  }
  function kindAt(yamlPathEnd: string): string | undefined {
    return issues.find((issue) => issue.yamlPath?.endsWith(yamlPathEnd))?.kind;
  }

  test("each mix-up has its own code, as each has its own fix", () => {
    expect(kindAt("tasks.no_extension.notebook_task.notebook_path")).toBe("notebook_missing_extension");
    expect(kindAt("tasks.plain_sql.notebook_task.notebook_path")).toBe("not_a_notebook");
    expect(kindAt("tasks.python_file_is_notebook.spark_python_task.python_file")).toBe("file_is_a_notebook");
    expect(kindAt("tasks.sql_file_is_notebook.sql_task.file.path")).toBe("file_is_a_notebook");
    expect(kindAt("libraries[0].notebook.path")).toBe("notebook_missing_extension");
    expect(kindAt("libraries[1].notebook.path")).toBe("not_a_notebook");
    expect(kindAt("libraries[2].file.path")).toBe("file_is_a_notebook");
  });

  test("job tasks follow the CLI's notebook rules", () => {
    expect(titleAt("tasks.no_extension.notebook_task.notebook_path")).toBe(
      'Notebook "../src/nb_noext" may not be found. Did you mean "../src/nb_noext.sql"?',
    );
    expect(titleAt("tasks.plain_sql.notebook_task.notebook_path")).toBe(
      '"../src/nb_plain.sql" may not be a notebook.',
    );
    expect(titleAt("tasks.bom.notebook_task.notebook_path")).toBe(
      '"../src/nb_bom.py" may not be a notebook.',
    );
    expect(titleAt("tasks.trailing_space.notebook_task.notebook_path")).toBe(
      '"../src/nb_trailing_space.py" may not be a notebook.',
    );
    for (const key of ["extra_text", "other_comment", "marker_in_code", "marker_at_190", "marker_past_200"]) {
      expect(kindAt(`tasks.${key}.notebook_task.notebook_path`)).toBe("not_a_notebook");
    }
    expect(titleAt("tasks.old_ipynb.notebook_task.notebook_path")).toBe(
      '"../src/nb_old.ipynb" may not be a notebook.',
    );
    expect(titleAt("tasks.python_file_is_notebook.spark_python_task.python_file")).toBe(
      '"../src/script_nb.py" may be a notebook, not a file.',
    );
    expect(titleAt("tasks.sql_file_is_notebook.sql_task.file.path")).toBe(
      '"../src/query_nb.sql" may be a notebook, not a file.',
    );
  });

  test("a path without its extension offers a fix that edits exactly that value in the resource file", () => {
    const fixable = issues.filter((issue) => issue.fix);
    expect(fixable.length).toBeGreaterThanOrEqual(2);
    for (const issue of fixable) {
      expect(issue.fix).toEqual({
        oldText: "../src/nb_noext",
        newText: "../src/nb_noext.sql",
        title: 'Change to "../src/nb_noext.sql"',
      });
      const lines = readFileSync(issue.file!, "utf8").split("\n");
      const line = lines[issue.line! - 1]!;
      const span = locateFix(line, issue.fix!.oldText, issue.column!);
      expect(span).toBeDefined();
      const fixed = line.slice(0, span!.start) + issue.fix!.newText + line.slice(span!.end);
      expect(fixed.trim()).toMatch(/^(- )?(notebook_path|path): \.\.\/src\/nb_noext\.sql$/);
    }
    // Only the missing extension has one exact fix; the other notebook mix-ups do not.
    expect(issues.filter((issue) => issue.kind !== "notebook_missing_extension" && issue.fix)).toEqual([]);
  });

  test("pipeline libraries follow the CLI's notebook rules", () => {
    expect(titleAt("libraries[0].notebook.path")).toBe(
      'Notebook "../src/nb_noext" may not be found. Did you mean "../src/nb_noext.sql"?',
    );
    expect(titleAt("libraries[1].notebook.path")).toBe(
      '"../src/nb_plain.sql" may not be a notebook.',
    );
    expect(titleAt("libraries[2].file.path")).toBe(
      '"../src/script_nb.py" may be a notebook, not a file.',
    );
  });

  test("valid notebooks and files, and git-sourced jobs, have no issue", () => {
    for (const ok of [
      "tasks.ok_sql.notebook_task.notebook_path",
      "tasks.crlf.notebook_task.notebook_path",
      "tasks.ok_ipynb.notebook_task.notebook_path",
      "tasks.python_file_ok.spark_python_task.python_file",
      "tasks.python_file_bom.spark_python_task.python_file",
      "tasks.from_git.notebook_task.notebook_path",
      "libraries[3].notebook.path",
    ]) {
      expect(titleAt(ok)).toBeUndefined();
    }
    expect(issues).toHaveLength(15);
  });

  test("a header that is close but not exact says why, and that a newer CLI takes it", () => {
    const issue = issues.find((i) => i.yamlPath?.endsWith("tasks.bom.notebook_task.notebook_path"));
    expect(issue?.fixHint).toBe(
      'Its first line has "Databricks notebook source" but isn\'t exactly "# Databricks notebook source". Databricks CLI versions before v1.24.0 need it exact, so an invisible byte order mark or other text on that line makes it a plain file. Make the first line exactly "# Databricks notebook source", or update the Databricks CLI.',
    );
  });

  test("the missing header hint names the header to add", () => {
    const issue = issues.find((i) => i.yamlPath?.endsWith("tasks.plain_sql.notebook_task.notebook_path"));
    expect(issue?.fixHint).toBe(
      'Add "-- Databricks notebook source" as its first line, or run it from a task that takes a file.',
    );
  });
});

describe("notebook path issues on the fixture bundle, CLI v1.24.0 and later", () => {
  let issues: InspectorIssue[];

  beforeAll(async () => {
    issues = await fixtureIssues("contains");
  });

  function kindAt(yamlPathEnd: string): string | undefined {
    return issues.find((issue) => issue.yamlPath?.endsWith(yamlPathEnd))?.kind;
  }

  test("a first line that contains the marker makes a notebook", () => {
    for (const key of ["bom", "trailing_space", "extra_text", "other_comment", "marker_in_code", "marker_at_190"]) {
      expect(kindAt(`tasks.${key}.notebook_task.notebook_path`)).toBeUndefined();
    }
  });

  test("only the first 200 bytes are read, so a marker after them doesn't count", () => {
    expect(kindAt("tasks.marker_past_200.notebook_task.notebook_path")).toBe("not_a_notebook");
  });

  test("so a file task on such a file is a notebook, not a file", () => {
    expect(kindAt("tasks.python_file_bom.spark_python_task.python_file")).toBe("file_is_a_notebook");
  });

  test("the other mix-ups are unchanged", () => {
    expect(kindAt("tasks.no_extension.notebook_task.notebook_path")).toBe("notebook_missing_extension");
    expect(kindAt("tasks.plain_sql.notebook_task.notebook_path")).toBe("not_a_notebook");
    expect(kindAt("tasks.old_ipynb.notebook_task.notebook_path")).toBe("not_a_notebook");
    expect(kindAt("tasks.python_file_is_notebook.spark_python_task.python_file")).toBe("file_is_a_notebook");
    expect(issues).toHaveLength(10);
  });

  test("the missing header hint is the plain one", () => {
    const issue = issues.find((i) => i.yamlPath?.endsWith("tasks.plain_sql.notebook_task.notebook_path"));
    expect(issue?.fixHint).toBe(
      'Add "-- Databricks notebook source" as its first line, or run it from a task that takes a file.',
    );
  });
});
