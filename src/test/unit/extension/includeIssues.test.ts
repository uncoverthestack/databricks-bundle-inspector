import { afterEach, describe, expect, test } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { includeIssues } from "../../../bundle/issues.js";

const JOB_FILE = "resources:\n  jobs:\n    a_job:\n      name: a\n";

const roots: string[] = [];

function makeBundle(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "include-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

// `include` is what `databricks bundle validate -o json` returns: the expanded file list,
// and no key at all when databricks.yml has no include.
function config(include?: string[]): ParsedBundleConfig {
  return { bundle: { name: "test" }, ...(include ? { include } : {}) } as ParsedBundleConfig;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("include pattern that matches nothing", () => {
  test("suggests the folder that was probably meant, at the line of the entry", () => {
    const root = makeBundle({
      "databricks.yml": "bundle:\n  name: test\ninclude:\n  - resource/*.yml\n",
      "resources/a.yml": JOB_FILE,
    });
    const [issue] = includeIssues(config(), root).filter((i) => i.kind === "include_matches_nothing");
    expect(issue).toMatchObject({
      severity: "warning",
      file: path.join(root, "databricks.yml"),
      line: 4,
    });
    expect(issue?.title).toBe(
      'No files match the include pattern "resource/*.yml", so nothing from it is loaded. Did you mean "resources/*.yml"?',
    );
  });

  test("suggests the other YAML extension", () => {
    const root = makeBundle({
      "databricks.yml": "include:\n  - 'resources/*.yml'\n",
      "resources/a.yaml": JOB_FILE,
    });
    const [issue] = includeIssues(config(), root).filter((i) => i.kind === "include_matches_nothing");
    expect(issue?.title).toContain('Did you mean "resources/*.yaml"?');
  });

  test("says nothing about a pattern with no likely fix, like a template default", () => {
    // Bundles whose resources are written in Python keep `resources/*.yml` while the folder
    // holds only .py files, and Databricks' own default-minimal template has the pattern
    // with no resources folder at all. Both are fine.
    const python = makeBundle({
      "databricks.yml": "include:\n  - resources/*.yml\n  - resources/*/*.yml\n",
      "resources/__init__.py": "",
      "resources/my_job.py": "",
    });
    const minimal = makeBundle({ "databricks.yml": "include:\n  - resources/*.yml\n" });
    expect(includeIssues(config(), python)).toEqual([]);
    expect(includeIssues(config(), minimal)).toEqual([]);
  });

  test("says nothing when the pattern matches a file", () => {
    const root = makeBundle({
      "databricks.yml": "include:\n  - resources/*.yml\n",
      "resources/a.yml": JOB_FILE,
    });
    expect(includeIssues(config(["resources/a.yml"]), root)).toEqual([]);
  });

  test("leaves an entry without wildcards to the CLI, which reports it itself", () => {
    const root = makeBundle({ "databricks.yml": "include:\n  - resources/missing.yml\n" });
    expect(includeIssues(config(), root)).toEqual([]);
  });
});

describe("resource file that include does not load", () => {
  test("flags a file in a sub-folder when the pattern only covers one level", () => {
    const root = makeBundle({
      "databricks.yml": "include:\n  - resources/*.yml\n",
      "resources/top.yml": JOB_FILE,
      "resources/jobs/nested.yml": "# jobs\n\nresources:\n  jobs:\n    n:\n      name: n\n",
    });
    const issues = includeIssues(config(["resources/top.yml"]), root);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: "resource_not_included",
      severity: "warning",
      file: path.join(root, "resources/jobs/nested.yml"),
      line: 3,
    });
    expect(issues[0]?.title).toBe(
      '"resources/jobs/nested.yml" defines resources, but no include entry loads it, so they are not part of the bundle.',
    );
  });

  test("adds the ** caveat to the hint when an entry uses it", () => {
    const root = makeBundle({
      "databricks.yml": "include:\n  - resources/**/*.yml\n",
      "resources/top.yml": JOB_FILE,
      "resources/jobs/nested.yml": JOB_FILE,
    });
    const [issue] = includeIssues(config(["resources/jobs/nested.yml"]), root);
    expect(issue?.file).toBe(path.join(root, "resources/top.yml"));
    expect(issue?.fixHint).toContain('treats "**" like "*"');
  });

  test("flags resource files when databricks.yml has no include at all", () => {
    const root = makeBundle({
      "databricks.yml": "bundle:\n  name: test\n",
      "resources/job.yml": JOB_FILE,
    });
    expect(includeIssues(config(), root).map((i) => i.id)).toEqual(["include:not-included:resources/job.yml"]);
  });

  test("says nothing when the CLI's list has every resource file", () => {
    const root = makeBundle({
      "databricks.yml": "include:\n  - resources/*.yml\n",
      "resources/a.yml": JOB_FILE,
    });
    expect(includeIssues(config(["resources/a.yml"]), root)).toEqual([]);
  });

  test("reads the CLI's list when it uses Windows separators", () => {
    const root = makeBundle({
      "databricks.yml": "include:\n  - resources/*.yml\n",
      "resources/a.yml": JOB_FILE,
    });
    expect(includeIssues(config(["resources\\a.yml"]), root)).toEqual([]);
  });

  test("treats a different folder casing in the CLI's list as the same file", () => {
    // On Windows and macOS the CLI keeps the casing of the pattern in its list, so a pattern
    // written `Resources/*.yml` lists `Resources/a.yml` for the folder `resources`. The
    // pattern here is spelled to match on every file system; only the CLI's list differs.
    const root = makeBundle({
      "databricks.yml": "include:\n  - resources/*.yml\n",
      "resources/a.yml": JOB_FILE,
    });
    expect(includeIssues(config(["Resources/a.yml"]), root)).toEqual([]);
  });

  test("treats capitals on disk as the same file as the CLI's list", () => {
    const root = makeBundle({
      "databricks.yml": "include:\n  - Resources/*.yml\n",
      "Resources/B.yml": JOB_FILE,
    });
    expect(includeIssues(config(["resources/b.yml"]), root)).toEqual([]);
  });

  test("says nothing when the include list is not the CLI's expanded answer", () => {
    const root = makeBundle({
      "databricks.yml": "include:\n  - resources/*.yml\n",
      "resources/a.yml": JOB_FILE,
      "other/b.yml": JOB_FILE,
    });
    // Still holds a pattern, as a hand-written fixture does: nothing can be concluded.
    expect(includeIssues(config(["resources/*.yml"]), root)).toEqual([]);
    // No list at all although databricks.yml has include entries.
    expect(includeIssues(config(), root).filter((i) => i.kind === "resource_not_included")).toEqual([]);
  });

  test("leaves out a file the bundle file names, such as a commented-out include", () => {
    const root = makeBundle({
      "databricks.yml":
        "include:\n  - ./resources/job.yml\n  # TODO: uncomment once the table exists\n  # - ./resources/monitoring.yml\n",
      "resources/job.yml": JOB_FILE,
      "resources/monitoring.yml": JOB_FILE,
      "resources/forgotten.yml": JOB_FILE,
    });
    const flagged = includeIssues(config(["resources/job.yml"]), root).map((i) => i.id);
    expect(flagged).toEqual(["include:not-included:resources/forgotten.yml"]);
  });

  test("ignores files that are not resources of this bundle", () => {
    const root = makeBundle({
      "databricks.yml": "resources:\n  jobs:\n    inline_job:\n      name: inline\n",
      // Another bundle in a sub-folder.
      "sub/databricks.yml": "bundle:\n  name: sub\n",
      "sub/resources/x.yml": JOB_FILE,
      // A hidden folder, a build folder and a YAML file that is not a bundle resource.
      ".hidden/y.yml": JOB_FILE,
      "node_modules/z/z.yml": JOB_FILE,
      "ci/pipeline.yml": "jobs:\n  build:\n    runs-on: ubuntu-latest\n",
      "empty/e.yml": "resources: {}\n",
      "not-yaml/broken.yml": "resources: [unclosed\n",
    });
    expect(includeIssues(config(), root)).toEqual([]);
  });
});
