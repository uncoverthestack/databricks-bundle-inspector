import { describe, test, expect, afterAll } from "@jest/globals";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectSecretInNotebook } from "../../../bundle/taskFileReferences.js";

const tempFiles: string[] = [];

async function py(name: string, content: string): Promise<string> {
  const file = path.join(tmpdir(), `bdi-test-${name}.py`);
  await writeFile(file, content, "utf8");
  tempFiles.push(file);
  return file;
}

async function notebook(name: string, cells: Array<string[]>): Promise<string> {
  const file = path.join(tmpdir(), `bdi-test-${name}.ipynb`);
  const notebook = {
    cells: cells.map((src) => ({ cell_type: "code", source: src })),
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  };
  await writeFile(file, JSON.stringify(notebook), "utf8");
  tempFiles.push(file);
  return file;
}

afterAll(async () => {
  await Promise.all(tempFiles.map((f) => unlink(f).catch(() => {})));
});

describe("scope extraction", () => {
  test("keyword arg with double quotes", async () => {
    const file = await py(
      "kw-double",
      `dbutils.secrets.get(scope="dev-scope", key="k")`,
    );
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBe("dev-scope");
  });

  test("keyword arg with single quotes", async () => {
    const file = await py(
      "kw-single",
      `dbutils.secrets.get(scope='dev-scope', key='k')`,
    );
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBe("dev-scope");
  });

  test("keyword arg with spaces around the = sign", async () => {
    const file = await py(
      "kw-spaces",
      `dbutils.secrets.get(scope = "dev-scope", key = "k")`,
    );
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBe("dev-scope");
  });

  test("positional string literal", async () => {
    const file = await py("positional", `dbutils.secrets.get("dev-scope")`);
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBe("dev-scope");
  });

  test("variable argument returns null scope", async () => {
    const file = await py("var-arg", `dbutils.secrets.get(scope_name)`);
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBeNull();
  });

  test("keyword variable argument returns null scope", async () => {
    const file = await py(
      "kw-var",
      `dbutils.secrets.get(scope=scope_name, key="k")`,
    );
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBeNull();
  });
});

describe("detection metadata", () => {
  test("reports the correct 1-based line number", async () => {
    const file = await py(
      "line-num",
      `line_one = 1\nline_two = 2\nx = dbutils.secrets.get("dev-scope")`,
    );
    const [result] = await detectSecretInNotebook(file);
    expect(result?.line).toBe(3);
  });

  test("raw contains the full source line", async () => {
    const src = `x = dbutils.secrets.get(scope="dev-scope", key="k")`;
    const file = await py("raw-line", src);
    const [result] = await detectSecretInNotebook(file);
    expect(result?.raw).toBe(src);
  });

  test("raw has no trailing \\r on CRLF files", async () => {
    const file = await py(
      "crlf",
      `line1\r\ndbutils.secrets.get("dev-scope")\r\nline3`,
    );
    const [result] = await detectSecretInNotebook(file);
    expect(result?.raw).toBe(`dbutils.secrets.get("dev-scope")`);
  });
});

describe("multi-line calls", () => {
  test("implicit continuation — arg on next line", async () => {
    const file = await py(
      "multiline-implicit",
      `x = dbutils.secrets.get(\n  "dev-scope"\n)`,
    );
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBe("dev-scope");
    expect(result?.line).toBe(1);
  });

  test("backslash continuation", async () => {
    const file = await py(
      "multiline-backslash",
      `x = dbutils.secrets.get(\\\n    "dev-scope"\n)`,
    );
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBe("dev-scope");
  });

  test("keyword arg spanning multiple lines", async () => {
    const file = await py(
      "multiline-kwarg",
      `x = dbutils.secrets.get(\n    scope="dev-scope",\n    key="k"\n)`,
    );
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBe("dev-scope");
  });
});

describe("false positive suppression", () => {
  test("ignores calls on a # comment line", async () => {
    const file = await py("comment", `# dbutils.secrets.get("dev-scope")`);
    const results = await detectSecretInNotebook(file);
    expect(results).toHaveLength(0);
  });

  test("ignores calls embedded inside a string literal", async () => {
    const file = await py(
      "in-string",
      `print("call dbutils.secrets.get('scope', 'key') to read secrets")`,
    );
    const results = await detectSecretInNotebook(file);
    expect(results).toHaveLength(0);
  });

  test("detects a real call that follows a closed string on the same line", async () => {
    const file = await py(
      "after-string",
      `x = "hello"; dbutils.secrets.get("dev-scope")`,
    );
    const results = await detectSecretInNotebook(file);
    expect(results).toHaveLength(1);
    expect(results[0]?.scope).toBe("dev-scope");
  });
});

describe("multiple calls in one file", () => {
  test("returns one detection per call with correct scopes", async () => {
    const file = await py(
      "multi-call",
      [
        `a = dbutils.secrets.get(scope="scope-a", key="k")`,
        `b = dbutils.secrets.get(scope_var)`,
        `c = dbutils.secrets.get("scope-c")`,
      ].join("\n"),
    );
    const results = await detectSecretInNotebook(file);

    expect(results).toHaveLength(3);
    expect(results[0]?.scope).toBe("scope-a");
    expect(results[1]?.scope).toBeNull();
    expect(results[2]?.scope).toBe("scope-c");
  });
});

describe(".ipynb notebooks", () => {
  test("detects a secret in a single code cell", async () => {
    const file = await notebook("basic", [
      [`dbutils.secrets.get(scope="nb-scope", key="k")\n`],
    ]);
    const results = await detectSecretInNotebook(file);

    expect(results).toHaveLength(1);
    expect(results[0]?.scope).toBe("nb-scope");
  });

  test("detects secrets across multiple cells", async () => {
    const file = await notebook("multi-cell", [
      [`from pyspark.sql import SparkSession\n`],
      [`x = dbutils.secrets.get("cell-2-scope")\n`],
      [`y = dbutils.secrets.get(scope="cell-3-scope", key="k")\n`],
    ]);
    const results = await detectSecretInNotebook(file);

    expect(results).toHaveLength(2);
    expect(results[0]?.scope).toBe("cell-2-scope");
    expect(results[1]?.scope).toBe("cell-3-scope");
  });

  test("ignores commented-out calls inside a cell", async () => {
    const file = await notebook("nb-comment", [
      [`# dbutils.secrets.get("scope")\n`, `real_code = 1\n`],
    ]);
    const results = await detectSecretInNotebook(file);

    expect(results).toHaveLength(0);
  });
});

describe("real fixture: secret-scope-example notebook.ipynb", () => {
  const fixturePath = path.join(
    __dirname,
    "../../fixtures/secret-scope-example/src/notebook.ipynb",
  );

  test("detects all three secret calls", async () => {
    const results = await detectSecretInNotebook(fixturePath);
    expect(results).toHaveLength(3);
  });

  test("all detections resolve to scope jdbc-test", async () => {
    const results = await detectSecretInNotebook(fixturePath);
    expect(results.every((r) => r.scope === "jdbc-test")).toBe(true);
  });
});
