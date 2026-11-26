import { afterAll, describe, expect, test } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pythonFacts } from "../../../bundle/code/pythonFacts.js";
import {
  detectRunTargetsInFile,
  detectSecretInNotebook,
  detectTaskValuesInFile,
  detectWidgetUsageInFile,
} from "../../../bundle/taskFileDetections.js";

const folders: string[] = [];

async function file(name: string, content: string): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "dbi-facts-"));
  folders.push(folder);
  const target = path.join(folder, name);
  await writeFile(target, content, "utf8");
  return target;
}

afterAll(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

describe("widget defaults come only from dbutils (#602)", () => {
  test("another object's widgets.text makes no default", async () => {
    const usage = await detectWidgetUsageInFile(
      await file("fake.py", 'class Fake:\n    pass\nFake.widgets.text("needed", "")\nv = dbutils.widgets.get("needed")\n'),
    );
    expect(usage.defaults).toEqual([]);
    expect(usage.reads.map((read) => read.name)).toEqual(["needed"]);
  });

  test("control: dbutils.widgets.text makes a default", async () => {
    const usage = await detectWidgetUsageInFile(await file("real.py", 'dbutils.widgets.text("needed", "")\nv = dbutils.widgets.get("needed")\n'));
    expect(usage.defaults).toEqual(["needed"]);
  });

  test("a default through an alias, self.dbutils or a factory still counts", async () => {
    const usage = await detectWidgetUsageInFile(
      await file(
        "aliases.py",
        [
          "w = dbutils.widgets",
          'w.text("a", "")',
          'self.dbutils.widgets.dropdown("b", "x", ["x"])',
          'get_dbutils(spark).widgets.combobox("c", "x", ["x"])',
          "from pyspark.dbutils import DBUtils as D",
          'D(spark).widgets.multiselect("d", "x", ["x"])',
        ].join("\n"),
      ),
    );
    expect(usage.defaults).toEqual(["a", "b", "c", "d"]);
  });
});

describe("a removed widget (#602)", () => {
  test("text, remove, then get: no default", async () => {
    const usage = await detectWidgetUsageInFile(
      await file("removed.py", 'dbutils.widgets.text("needed", "")\ndbutils.widgets.remove("needed")\nv = dbutils.widgets.get("needed")\n'),
    );
    expect(usage.defaults).toEqual([]);
  });

  test("removeAll removes every widget created before it", async () => {
    const usage = await detectWidgetUsageInFile(
      await file("remove-all.py", 'dbutils.widgets.text("a", "")\ndbutils.widgets.removeAll()\nv = dbutils.widgets.get("a")\n'),
    );
    expect(usage.defaults).toEqual([]);
  });

  test("control: text, get, then remove keeps the default", async () => {
    const usage = await detectWidgetUsageInFile(
      await file("read-first.py", 'dbutils.widgets.text("needed", "")\nv = dbutils.widgets.get("needed")\ndbutils.widgets.remove("needed")\n'),
    );
    expect(usage.defaults).toEqual(["needed"]);
  });

  test("control: created again after the remove keeps the default", async () => {
    const usage = await detectWidgetUsageInFile(
      await file(
        "recreated.py",
        'dbutils.widgets.text("needed", "")\ndbutils.widgets.remove("needed")\ndbutils.widgets.text("needed", "")\nv = dbutils.widgets.get("needed")\n',
      ),
    );
    expect(usage.defaults).toEqual(["needed", "needed"]);
  });
});

describe("a bound getter (#602)", () => {
  test("read = dbutils.widgets.get, then read('needed') is a named read", async () => {
    const usage = await detectWidgetUsageInFile(await file("bound.py", 'read_widget = dbutils.widgets.get\nv = read_widget("needed")\n'));
    expect(usage.reads).toEqual([{ name: "needed", line: 2, language: "python" }]);
  });

  test("a bound getter handed to other code makes reads dynamic", async () => {
    const usage = await detectWidgetUsageInFile(await file("bound-passed.py", "helper(dbutils.widgets.get)\n"));
    expect(usage.hasDynamicReads).toBe(true);
  });
});

describe("f-strings (#602)", () => {
  test("a # comment with } inside a multi-line f-string doesn't hide later reads", async () => {
    const usage = await detectWidgetUsageInFile(
      await file("fstring.py", 'msg = f"""{\n  1  # a } comment\n}"""\nv = dbutils.widgets.get("needed")\n'),
    );
    expect(usage.reads.map((read) => read.name)).toEqual(["needed"]);
  });
});

describe("task values through an alias (#601)", () => {
  test("tv = dbutils.jobs.taskValues, then tv.get(...) is read", async () => {
    const usage = await detectTaskValuesInFile(
      await file("alias.py", 'tv = dbutils.jobs.taskValues\nx = tv.get(taskKey="missing", key="missing")\ntv.set(key="k", value=1)\n'),
    );
    expect(usage.gets).toEqual([{ taskKey: "missing", key: "missing", hasDefault: false, line: 2 }]);
    expect(usage.sets).toEqual([{ key: "k", line: 3 }]);
  });

  test("jobs = dbutils.jobs, then jobs.taskValues.get(...) is read", async () => {
    const usage = await detectTaskValuesInFile(await file("jobs.py", 'jobs = dbutils.jobs\nx = jobs.taskValues.get("t", "k", default=0)\n'));
    expect(usage.gets).toEqual([{ taskKey: "t", key: "k", hasDefault: true, line: 2 }]);
  });

  test("control: an unknown object's taskValues.get is not a read", async () => {
    const usage = await detectTaskValuesInFile(await file("unknown.py", 'x = other.jobs.taskValues.get("t", "k")\n'));
    expect(usage.gets).toEqual([]);
  });
});

describe("names followed in order", () => {
  test("a module variable reassigned to something else stops being followed", async () => {
    const usage = await detectWidgetUsageInFile(
      await file("reassigned.py", 'w = dbutils.widgets\na = w.get("one")\nw = Fake()\nb = w.get("two")\n'),
    );
    // `w` is a Fake by then: its `get` is not a widget read.
    expect(usage.reads.map((read) => read.name)).toEqual(["one"]);
    expect(usage.hasDynamicReads).toBe(false);
  });

  test("dbutils reassigned from an SDK client is still dbutils", async () => {
    const secrets = await detectSecretInNotebook(
      await file("sdk.py", 'from databricks.sdk import WorkspaceClient\nw = WorkspaceClient()\ndbutils = w.dbutils\ndbutils.secrets.get("s", "k")\nw.secrets.get_secret("t", "k2")\n'),
    );
    expect(secrets.map((secret) => [secret.scope, secret.key])).toEqual([["s", "k"], ["t", "k2"]]);
  });

  test("a name imported as dbutils from elsewhere is not dbutils", async () => {
    const secrets = await detectSecretInNotebook(await file("shadow.py", 'from mylib import helper as dbutils\ndbutils.secrets.get("s", "k")\n'));
    expect(secrets).toEqual([]);
  });

  test("a helper's dbutils parameter is still dbutils", async () => {
    const secrets = await detectSecretInNotebook(await file("param.py", 'def read(dbutils):\n    return dbutils.secrets.get("s", "k")\n'));
    expect(secrets.map((secret) => secret.scope)).toEqual(["s"]);
  });
});

describe("secret scope from a widget (#535)", () => {
  test("a name assigned once from a widget read", async () => {
    const [secret] = await detectSecretInNotebook(
      await file("scope-param.py", 'scope = dbutils.widgets.get("scope")\ndbutils.secrets.get(scope, "k")\n'),
    );
    expect(secret).toMatchObject({ scope: null, scopeParameter: "scope" });
  });

  test("control: a name also bound in a loop has no parameter", async () => {
    const [secret] = await detectSecretInNotebook(
      await file("scope-loop.py", 'scope = dbutils.widgets.get("scope")\nfor scope in scopes:\n    dbutils.secrets.get(scope, "k")\n'),
    );
    expect(secret?.scopeParameter).toBeUndefined();
  });
});

describe("notebook runs", () => {
  test("dbutils.notebook.run through an alias", async () => {
    const runs = await detectRunTargetsInFile(await file("runs.py", 'nb = dbutils.notebook\nnb.run("./child", 60)\nother.notebook.run("./no", 60)\n'));
    expect(runs.map((run) => [run.kind, run.target, run.line])).toEqual([["notebook_run", "./child", 2]]);
  });
});

describe("Scala keeps the tokenizer", () => {
  test("a Scala file's dbutils reads are still found", async () => {
    const usage = await detectWidgetUsageInFile(await file("job.scala", 'val v = dbutils.widgets.get("needed")\n'));
    expect(usage.reads.map((read) => read.name)).toEqual(["needed"]);
  });
});

describe("pythonFacts", () => {
  test("empty text has no facts", async () => {
    expect(await pythonFacts("   \n")).toEqual({ calls: [], passesWidgets: false });
  });

  test("code with a syntax error still yields the calls in its valid parts", async () => {
    const facts = await pythonFacts('def broken(:\n    pass\nv = dbutils.widgets.get("a")\n');
    expect(facts.calls.map((call) => [call.module, call.method])).toContainEqual(["widgets", "get"]);
  });

  test("a call after *args has no known position for later arguments", async () => {
    const facts = await pythonFacts('dbutils.secrets.get(*parts)\n');
    expect(facts.calls[0]?.args).toEqual([{ value: null, isNone: false, splat: true }]);
  });
});
