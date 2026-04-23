import { describe, test, expect, afterAll } from "@jest/globals";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  detectSecretInNotebook,
  detectWidgetsInFile,
} from "../../../bundle/taskFileDetections.js";

// Secret scope Detection & Retrieval

const tempFiles: string[] = [];

const SQL_PREVIEW_NOTE =
  "secret() and try_secret() are Databricks SQL preview features";

async function py(name: string, content: string): Promise<string> {
  const file = path.join(tmpdir(), `bdi-test-${name}.py`);
  await writeFile(file, content, "utf8");
  tempFiles.push(file);
  return file;
}

async function sql(name: string, content: string): Promise<string> {
  const file = path.join(tmpdir(), `bdi-test-${name}.sql`);
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

describe("key extraction", () => {
  test("keyword args — both scope and key extracted", async () => {
    const file = await py(
      "key-kw",
      `dbutils.secrets.get(scope="dev-scope", key="my-key")`,
    );
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBe("dev-scope");
    expect(result?.key).toBe("my-key");
  });

  test("positional args — both scope and key extracted", async () => {
    const file = await py(
      "key-positional",
      `dbutils.secrets.get("dev-scope", "my-key")`,
    );
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBe("dev-scope");
    expect(result?.key).toBe("my-key");
  });

  test("only scope provided — key is null", async () => {
    const file = await py("key-missing", `dbutils.secrets.get("dev-scope")`);
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBe("dev-scope");
    expect(result?.key).toBeNull();
  });

  test("key is a variable — key is null", async () => {
    const file = await py(
      "key-var",
      `dbutils.secrets.get(scope="dev-scope", key=key_var)`,
    );
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBe("dev-scope");
    expect(result?.key).toBeNull();
  });

  test("both args are variables — scope and key are null", async () => {
    const file = await py("key-both-var", `dbutils.secrets.get(s, k)`);
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBeNull();
    expect(result?.key).toBeNull();
  });
});

describe("getBytes variant", () => {
  test("detects dbutils.secrets.getBytes()", async () => {
    const file = await py(
      "get-bytes",
      `dbutils.secrets.getBytes(scope="my-scope", key="my-key")`,
    );
    const results = await detectSecretInNotebook(file);
    expect(results).toHaveLength(1);
    expect(results[0]?.scope).toBe("my-scope");
    expect(results[0]?.key).toBe("my-key");
  });

  test("getBytes with positional args", async () => {
    const file = await py(
      "get-bytes-positional",
      `dbutils.secrets.getBytes("my-scope", "my-key")`,
    );
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBe("my-scope");
    expect(result?.key).toBe("my-key");
  });

  test("getBytes in comment is ignored", async () => {
    const file = await py(
      "get-bytes-comment",
      `# dbutils.secrets.getBytes("my-scope", "my-key")`,
    );
    const results = await detectSecretInNotebook(file);
    expect(results).toHaveLength(0);
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

describe("f-string expressions", () => {
  test("detects widget get() inside an f-string expression", async () => {
    const file = await py(
      "fstr-widget",
      `query = f"SELECT {dbutils.widgets.get('env')} FROM table"`,
    );
    const results = await detectWidgetsInFile(file);
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("env");
    expect(results[0]?.method).toBe("get");
  });

  test("does not detect a plain string that documents the call", async () => {
    const file = await py(
      "fstr-plain",
      `x = "use dbutils.widgets.get('name') to read a widget"`,
    );
    const results = await detectWidgetsInFile(file);
    expect(results).toHaveLength(0);
  });

  test("detects secret get() inside an f-string expression", async () => {
    const file = await py(
      "fstr-secret",
      `q = f"token={dbutils.secrets.get(scope='sc', key='k')}"`,
    );
    const results = await detectSecretInNotebook(file);
    expect(results).toHaveLength(1);
    expect(results[0]?.scope).toBe("sc");
    expect(results[0]?.key).toBe("k");
  });

  test("multiple calls in one f-string are each detected", async () => {
    const file = await py(
      "fstr-multi",
      `q = f"SELECT {dbutils.widgets.get('db')}.{dbutils.widgets.get('tbl')}"`,
    );
    const results = await detectWidgetsInFile(file);
    expect(results).toHaveLength(2);
    expect(results[0]?.name).toBe("db");
    expect(results[1]?.name).toBe("tbl");
  });

  test("escaped {{ }} braces are not treated as expression openers", async () => {
    const file = await py(
      "fstr-escaped",
      `s = f"literal {{braces}} then {dbutils.widgets.get('name')}"`,
    );
    const results = await detectWidgetsInFile(file);
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("name");
  });
});

describe("case sensitivity", () => {
  test("DBUTILS.SECRETS.GET in .py is not detected", async () => {
    const file = await py(
      "case-py",
      `x = DBUTILS.SECRETS.GET(scope="dev-scope", key="k")`,
    );
    const results = await detectSecretInNotebook(file);
    expect(results).toHaveLength(0);
  });

  test("SECRET() and TRY_SECRET() in uppercase SQL are detected (case-insensitive)", async () => {
    const file = await sql(
      "case-sql",
      [`SELECT SECRET('scope-a', 'k1'), TRY_SECRET('scope-b', 'k2')`].join(""),
    );
    const results = await detectSecretInNotebook(file);
    expect(results).toHaveLength(2);
    expect(results[0]?.scope).toBe("scope-a");
    expect(results[1]?.scope).toBe("scope-b");
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

  test("detects getBytes in a notebook cell with correct scope and key", async () => {
    const file = await notebook("nb-get-bytes", [
      [`cert = dbutils.secrets.getBytes(scope="nb-scope", key="tls-cert")\n`],
    ]);
    const results = await detectSecretInNotebook(file);

    expect(results).toHaveLength(1);
    expect(results[0]?.scope).toBe("nb-scope");
    expect(results[0]?.key).toBe("tls-cert");
  });

  test("case-sensitive: DBUTILS.SECRETS.GET is not detected", async () => {
    const file = await notebook("nb-case", [
      [`x = DBUTILS.SECRETS.GET(scope="nb-scope", key="k")\n`],
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

  test("detects all four secret calls (three get + one getBytes)", async () => {
    const results = await detectSecretInNotebook(fixturePath);
    expect(results).toHaveLength(4);
  });

  test("all detections resolve to scope jdbc-test", async () => {
    const results = await detectSecretInNotebook(fixturePath);
    expect(results.every((r) => r.scope === "jdbc-test")).toBe(true);
  });

  test("getBytes call resolves key tls-cert", async () => {
    const results = await detectSecretInNotebook(fixturePath);
    const getBytesResult = results.find((r) => r.key === "tls-cert");
    expect(getBytesResult).toBeDefined();
    expect(getBytesResult?.scope).toBe("jdbc-test");
  });
});

describe(".sql files — secret()", () => {
  test("extracts scope and key from secret() with single quotes", async () => {
    const file = await sql(
      "secret-single",
      `SELECT secret('dev-scope', 'my-key')`,
    );
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBe("dev-scope");
    expect(result?.key).toBe("my-key");
  });

  test("extracts scope and key from secret() with double quotes", async () => {
    const file = await sql(
      "secret-double",
      `SELECT secret("dev-scope", "my-key")`,
    );
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBe("dev-scope");
    expect(result?.key).toBe("my-key");
  });

  test("extracts scope and key from try_secret()", async () => {
    const file = await sql(
      "try-secret",
      `SELECT try_secret('dev-scope', 'my-key')`,
    );
    const [result] = await detectSecretInNotebook(file);
    expect(result?.scope).toBe("dev-scope");
    expect(result?.key).toBe("my-key");
  });

  test("every SQL detection carries the preview note", async () => {
    const file = await sql(
      "preview-note",
      [
        `SELECT secret('scope-a', 'k1'),`,
        `       try_secret('scope-b', 'k2')`,
      ].join("\n"),
    );
    const results = await detectSecretInNotebook(file);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.note === SQL_PREVIEW_NOTE)).toBe(true);
  });

  test("Python detections carry no note", async () => {
    const file = await py("no-note", `dbutils.secrets.get(scope="s", key="k")`);
    const [result] = await detectSecretInNotebook(file);
    expect(result?.note).toBeUndefined();
  });
});

describe(".sql files — false positive suppression", () => {
  test("ignores calls after a -- line comment", async () => {
    const file = await sql("sql-comment", `-- secret('dev-scope', 'my-key')`);
    const results = await detectSecretInNotebook(file);
    expect(results).toHaveLength(0);
  });

  test("ignores calls inside a string literal", async () => {
    const file = await sql(
      "sql-in-string",
      `SELECT 'use secret(''scope'', ''key'') to read a value'`,
    );
    const results = await detectSecretInNotebook(file);
    expect(results).toHaveLength(0);
  });

  test("ignores calls inside an inline block comment", async () => {
    const file = await sql(
      "sql-block-comment",
      `SELECT /* secret('dev-scope', 'key') */ 1`,
    );
    const results = await detectSecretInNotebook(file);
    expect(results).toHaveLength(0);
  });

  test("detects a call that follows a closed string on the same line", async () => {
    const file = await sql(
      "sql-after-string",
      `SELECT 'hello', secret('dev-scope', 'key')`,
    );
    const results = await detectSecretInNotebook(file);
    expect(results).toHaveLength(1);
    expect(results[0]?.scope).toBe("dev-scope");
  });
});

// WIDGET Detection + Retrieval

const WIDGET_DEPRECATED_NOTE =
  "dbutils.widgets.getArgument() is deprecated; use dbutils.widgets.get() instead";

describe("widgets — name extraction", () => {
  test("positional string literal double quotes", async () => {
    const file = await py("wgt-dbl", `dbutils.widgets.get("my-widget")`);
    const [result] = await detectWidgetsInFile(file);
    expect(result?.name).toBe("my-widget");
    expect(result?.method).toBe("get");
  });

  test("positional string literal single quotes", async () => {
    const file = await py("wgt-sgl", `dbutils.widgets.get('my-widget')`);
    const [result] = await detectWidgetsInFile(file);
    expect(result?.name).toBe("my-widget");
  });

  test("variable argument returns null name", async () => {
    const file = await py("wgt-var", `dbutils.widgets.get(widget_name)`);
    const [result] = await detectWidgetsInFile(file);
    expect(result?.name).toBeNull();
    expect(result?.method).toBe("get");
  });
});

describe("widgets — detection metadata", () => {
  test("reports correct 1-based line number", async () => {
    const file = await py(
      "wgt-line",
      `line_one = 1\nx = dbutils.widgets.get("my-widget")`,
    );
    const [result] = await detectWidgetsInFile(file);
    expect(result?.line).toBe(2);
  });

  test("raw contains the full source line", async () => {
    const src = `x = dbutils.widgets.get("my-widget")`;
    const file = await py("wgt-raw", src);
    const [result] = await detectWidgetsInFile(file);
    expect(result?.raw).toBe(src);
  });
});

describe("widgets — getArgument (deprecated)", () => {
  test("extracts widget name from first positional arg", async () => {
    const file = await py(
      "wgt-getarg",
      `dbutils.widgets.getArgument("env", "default")`,
    );
    const [result] = await detectWidgetsInFile(file);
    expect(result?.name).toBe("env");
    expect(result?.method).toBe("getArgument");
  });

  test("carries the deprecation note", async () => {
    const file = await py(
      "wgt-getarg-note",
      `dbutils.widgets.getArgument("env", "default")`,
    );
    const [result] = await detectWidgetsInFile(file);
    expect(result?.note).toBe(WIDGET_DEPRECATED_NOTE);
  });
});

describe("widgets — getAll", () => {
  test("name is null and method is getAll", async () => {
    const file = await py("wgt-getall", `params = dbutils.widgets.getAll()`);
    const [result] = await detectWidgetsInFile(file);
    expect(result?.name).toBeNull();
    expect(result?.method).toBe("getAll");
  });

  test("carries no note", async () => {
    const file = await py("wgt-getall-note", `dbutils.widgets.getAll()`);
    const [result] = await detectWidgetsInFile(file);
    expect(result?.note).toBeUndefined();
  });
});

describe("widgets — false positive suppression", () => {
  test("ignores calls on a # comment line", async () => {
    const file = await py("wgt-comment", `# dbutils.widgets.get("my-widget")`);
    const results = await detectWidgetsInFile(file);
    expect(results).toHaveLength(0);
  });

  test("ignores calls inside a string literal", async () => {
    const file = await py(
      "wgt-in-string",
      `print("use dbutils.widgets.get('name') to read a widget")`,
    );
    const results = await detectWidgetsInFile(file);
    expect(results).toHaveLength(0);
  });

  test("DBUTILS.WIDGETS.GET in uppercase is not detected (case-sensitive)", async () => {
    const file = await py("wgt-case", `x = DBUTILS.WIDGETS.GET("my-widget")`);
    const results = await detectWidgetsInFile(file);
    expect(results).toHaveLength(0);
  });

  test("SQL files return empty array", async () => {
    const file = await sql("wgt-sql", `SELECT :my_widget`);
    const results = await detectWidgetsInFile(file);
    expect(results).toHaveLength(0);
  });
});

describe("widgets — multiple calls in one file", () => {
  test("returns one detection per call with correct names and methods", async () => {
    const file = await py(
      "wgt-multi",
      [
        `env = dbutils.widgets.get("environment")`,
        `region = dbutils.widgets.get(region_var)`,
        `legacy = dbutils.widgets.getArgument("old-param", "default")`,
        `all_params = dbutils.widgets.getAll()`,
      ].join("\n"),
    );
    const results = await detectWidgetsInFile(file);

    expect(results).toHaveLength(4);
    expect(results[0]?.name).toBe("environment");
    expect(results[0]?.method).toBe("get");
    expect(results[1]?.name).toBeNull();
    expect(results[1]?.method).toBe("get");
    expect(results[2]?.name).toBe("old-param");
    expect(results[2]?.method).toBe("getArgument");
    expect(results[3]?.name).toBeNull();
    expect(results[3]?.method).toBe("getAll");
  });
});

describe("widgets — .ipynb notebooks", () => {
  test("detects get() in a single code cell", async () => {
    const file = await notebook("wgt-nb-basic", [
      [`env = dbutils.widgets.get("nb-env")\n`],
    ]);
    const results = await detectWidgetsInFile(file);

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("nb-env");
    expect(results[0]?.method).toBe("get");
  });

  test("detects calls across multiple cells", async () => {
    const file = await notebook("wgt-nb-multi", [
      [`env = dbutils.widgets.get("environment")\n`],
      [`region = dbutils.widgets.getArgument("region", "us-east-1")\n`],
    ]);
    const results = await detectWidgetsInFile(file);

    expect(results).toHaveLength(2);
    expect(results[0]?.name).toBe("environment");
    expect(results[1]?.name).toBe("region");
    expect(results[1]?.method).toBe("getArgument");
  });

  test("ignores commented-out calls inside a cell", async () => {
    const file = await notebook("wgt-nb-comment", [
      [`# dbutils.widgets.get("env")\n`, `x = 1\n`],
    ]);
    const results = await detectWidgetsInFile(file);
    expect(results).toHaveLength(0);
  });
});

describe("real widgets: notebook.ipynb", () => {
  const fixturePath = path.join(
    __dirname,
    "../../fixtures/secret-scope-example/src/notebook.ipynb",
  );

  test("detects all 4 widgets", async () => {
    const results = await detectWidgetsInFile(fixturePath);
    expect(results).toHaveLength(4);
  });

  test("all detections of defined widgets", async () => {
    const results = await detectWidgetsInFile(fixturePath);
    expect(results[0]?.name).toBe("table_name");
    expect(results[1]?.name).toBe("target_table_name");
    expect(results[2]?.name).toBe("filter_str");
    expect(results[3]?.name).toBe("sub_table_name");
  });
});
