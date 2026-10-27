import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { filesUnder, movedFileSuggestion } from "../../../bundle/pathSuggestions.js";

const NOTEBOOK = "# Databricks notebook source\nprint(1)\n";
let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dbi-path-suggestions-"));
  const files: Record<string, string> = {
    "resources/job.yml": "",
    "src/train.py": NOTEBOOK,
    "src/run.py": "print(1)\n",
    "node_modules/pkg/train.py": NOTEBOOK,
    ".databricks/bundle/dev/train.py": NOTEBOOK,
  };
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const suggest = (rawPath: string, expects: "notebook" | "file" | "any", sourceFile = path.join(root, "resources", "job.yml")) =>
  movedFileSuggestion({
    rawPath,
    resolvedPath: path.resolve(path.dirname(sourceFile), rawPath),
    sourceFile,
    expects,
    files: () => filesUnder(root),
    excluded: () => false,
  });

describe("movedFileSuggestion", () => {
  test("skips installed and generated folders", () => {
    const files = filesUnder(root).map((file) => path.relative(root, file).split(path.sep).join("/"));
    expect(files.sort()).toEqual(["resources/job.yml", "src/run.py", "src/train.py"]);
  });

  test("writes the path from the YAML file's folder, with forward slashes", () => {
    expect(suggest("../notebooks/train.py", "notebook")).toBe("../src/train.py");
    expect(suggest("notebooks/train.py", "notebook", path.join(root, "databricks.yml"))).toBe("src/train.py");
  });

  test("keeps a leading ./ when the file is below the YAML file's folder", () => {
    expect(suggest("./notebooks/train.py", "notebook", path.join(root, "databricks.yml"))).toBe("./src/train.py");
    expect(suggest("./train.py", "notebook")).toBe("../src/train.py");
  });

  test("only a file of the kind the field takes", () => {
    expect(suggest("../x/train.py", "file")).toBeUndefined();
    expect(suggest("../x/run.py", "notebook")).toBeUndefined();
    expect(suggest("../x/run.py", "file")).toBe("../src/run.py");
    expect(suggest("../x/run.py", "any")).toBe("../src/run.py");
  });

  test("nothing for a file left out of the upload, or when no file has the name", () => {
    expect(
      movedFileSuggestion({
        rawPath: "../x/train.py",
        resolvedPath: path.join(root, "x", "train.py"),
        sourceFile: path.join(root, "resources", "job.yml"),
        expects: "notebook",
        files: () => filesUnder(root),
        excluded: (file) => file.endsWith("train.py"),
      }),
    ).toBeUndefined();
    expect(suggest("../x/missing.py", "any")).toBeUndefined();
  });
});
