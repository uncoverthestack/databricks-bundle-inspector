import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPipelineLibraryReferences } from "../../../bundle/resources/pipeline.js";

let bundleRoot: string;
let resourcesDir: string;

beforeAll(async () => {
  bundleRoot = await mkdtemp(path.join(tmpdir(), "bdi-pipeline-test-"));
  resourcesDir = path.join(bundleRoot, "resources");
  await mkdir(resourcesDir);
  await mkdir(path.join(bundleRoot, "src", "dlt", "transforms", "nested"), { recursive: true });
  await mkdir(path.join(bundleRoot, "src", "empty"), { recursive: true });
  await writeFile(path.join(bundleRoot, "src", "empty", ".gitkeep"), "", "utf8");
  await writeFile(path.join(bundleRoot, "src", "dlt", "bronze.py"), "# notebook", "utf8");
  await writeFile(path.join(bundleRoot, "src", "dlt", "helpers.py"), "x = 1", "utf8");
  await writeFile(path.join(bundleRoot, "src", "dlt", "transforms", "nested", "a.sql"), "select 1", "utf8");
});

afterAll(async () => {
  await rm(bundleRoot, { recursive: true, force: true });
});

function refsFor(libraries: unknown[]) {
  return getPipelineLibraryReferences(
    { libraries },
    path.join(resourcesDir, "pipelines.yml"),
    resourcesDir,
    bundleRoot,
  ).map((ref) => ({ kind: ref.kind, path: ref.path, exists: ref.exists, checked: ref.checked }));
}

describe("getPipelineLibraryReferences", () => {
  test("finds existing notebook and file sources relative to the declaring YAML file", () => {
    expect(
      refsFor([
        { notebook: { path: "../src/dlt/bronze.py" } },
        { file: { path: "../src/dlt/helpers.py" } },
      ]),
    ).toEqual([
      { kind: "notebook", path: "../src/dlt/bronze.py", exists: true, checked: true },
      { kind: "file", path: "../src/dlt/helpers.py", exists: true, checked: true },
    ]);
  });

  test("treats a notebook path without its extension as not found, as the CLI does", () => {
    expect(refsFor([{ notebook: { path: "../src/dlt/bronze" } }])).toEqual([
      { kind: "notebook", path: "../src/dlt/bronze", exists: false, checked: true },
    ]);
    const [ref] = getPipelineLibraryReferences(
      { libraries: [{ notebook: { path: "../src/dlt/bronze" } }] },
      path.join(resourcesDir, "pipelines.yml"),
      resourcesDir,
      bundleRoot,
    );
    expect(ref?.notebookProblem).toEqual({
      kind: "missing_extension",
      suggestedPath: "../src/dlt/bronze.py",
    });
  });

  test("reports missing notebook and file sources", () => {
    expect(
      refsFor([
        { notebook: { path: "../src/dlt/missing.py" } },
        { file: { path: "../src/dlt/missing_file.py" } },
      ]),
    ).toEqual([
      { kind: "notebook", path: "../src/dlt/missing.py", exists: false, checked: true },
      { kind: "file", path: "../src/dlt/missing_file.py", exists: false, checked: true },
    ]);
  });

  test("checks folder/** and folder/* globs for at least one file", () => {
    expect(
      refsFor([
        { glob: { include: "../src/dlt/transforms/**" } },
        { glob: { include: "../src/dlt/transforms/*" } },
        { glob: { include: "../src/empty/**" } },
        { glob: { include: "../src/nowhere/**" } },
      ]),
    ).toEqual([
      // nested/a.sql is found recursively by **
      { kind: "glob", path: "../src/dlt/transforms/**", exists: true, checked: true },
      // * only looks directly inside transforms/, which holds a folder but no file
      { kind: "glob", path: "../src/dlt/transforms/*", exists: false, checked: true },
      // only a hidden .gitkeep, which is not a source
      { kind: "glob", path: "../src/empty/**", exists: false, checked: true },
      { kind: "glob", path: "../src/nowhere/**", exists: false, checked: true },
    ]);
  });

  test("leaves workspace paths, variables and complex globs unchecked", () => {
    expect(
      refsFor([
        { notebook: { path: "/Users/someone@example.com/pipelines/bronze" } },
        { notebook: { path: "/Workspace/Shared/bronze" } },
        { file: { path: "${var.source_dir}/bronze.py" } },
        { glob: { include: "../src/dlt/*.py" } },
      ]),
    ).toEqual([
      { kind: "notebook", path: "/Users/someone@example.com/pipelines/bronze", exists: false, checked: false },
      { kind: "notebook", path: "/Workspace/Shared/bronze", exists: false, checked: false },
      { kind: "file", path: "${var.source_dir}/bronze.py", exists: false, checked: false },
      { kind: "glob", path: "../src/dlt/*.py", exists: false, checked: false },
    ]);
  });

  test("ignores libraries that are not local sources", () => {
    expect(refsFor([{ jar: "dbfs:/libs/a.jar" }, { maven: { coordinates: "a:b:1" } }, null])).toEqual([]);
  });
});
