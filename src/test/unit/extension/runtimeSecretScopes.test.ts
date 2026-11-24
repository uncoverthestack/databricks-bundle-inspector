import { describe, expect, test } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectSecretInNotebook } from "../../../bundle/taskFileDetections.js";

// Hand-worked cases: which notebook parameter a secret's scope comes from (issue 535). A name
// is traced only when the file shows its value plainly; anything else stays unknown.
async function scopes(code: string): Promise<string[]> {
  const dir = mkdtempSync(path.join(tmpdir(), "runtime-secret-"));
  try {
    const file = path.join(dir, "nb.py");
    writeFileSync(file, `# Databricks notebook source\n${code}\n`);
    return (await detectSecretInNotebook(file)).map((d) => d.scope ?? (d.scopeParameter ? `param:${d.scopeParameter}` : "unknown"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the parameter a secret's scope comes from", () => {
  test.each([
    ['dbutils.secrets.get(scope="kv", key="pw")', ["kv"]],
    ['dbutils.secrets.get(scope=dbutils.widgets.get("env_scope"), key="pw")', ["param:env_scope"]],
    ['dbutils.secrets.get(dbutils.widgets.get("env_scope"), "pw")', ["param:env_scope"]],
    ['dbutils.secrets.get(dbutils.widgets.getArgument("env_scope"), "pw")', ["param:env_scope"]],
    ['s = dbutils.widgets.get("env_scope")\ndbutils.secrets.get(scope=s, key="pw")', ["param:env_scope"]],
    ['w = dbutils.widgets\ns = w.get("env_scope")\ndbutils.secrets.get(s, "pw")', ["param:env_scope"]],
    // Not plain: changed after reading, set twice, built, or a function's own argument.
    ['s = dbutils.widgets.get("env_scope").strip()\ndbutils.secrets.get(s, "pw")', ["unknown"]],
    ['s = dbutils.widgets.get("a")\ns = dbutils.widgets.get("b")\ndbutils.secrets.get(s, "pw")', ["unknown"]],
    ['s = dbutils.widgets.get("a")\ns += "-kv"\ndbutils.secrets.get(s, "pw")', ["unknown"]],
    ['team = dbutils.widgets.get("team")\ndbutils.secrets.get(f"{team}-kv", "pw")', ["unknown"]],
    ['s = dbutils.widgets.get("a")\ndef read(s):\n    return dbutils.secrets.get(s, "pw")', ["unknown"]],
    ['s = dbutils.widgets.get("a")\nfor s in ["x", "y"]:\n    dbutils.secrets.get(s, "pw")', ["unknown"]],
    ['s = dbutils.widgets.get("a")\nwith open("f") as s:\n    dbutils.secrets.get(s, "pw")', ["unknown"]],
    ['dbutils.secrets.get(scope=get_scope(), key="pw")', ["unknown"]],
    ['dbutils.secrets.get(scope=dbutils.widgets.get(name), key="pw")', ["unknown"]],
  ])("%s", async (code, expected) => {
    expect(await scopes(code)).toEqual(expected);
  });
});

describe("tuple targets", () => {
  test("a name unpacked from a tuple is unknown; a keyword argument is not a tuple", async () => {
    expect(await scopes('s = dbutils.widgets.get("a")\ns, t = 1, 2\ndbutils.secrets.get(s, "pw")')).toEqual(["unknown"]);
    expect(await scopes('s = dbutils.widgets.get("a")\nprint(x, s, y)\ndbutils.secrets.get(scope=s, key="pw")')).toEqual(["param:a"]);
  });
});
