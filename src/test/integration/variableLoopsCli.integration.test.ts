import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { validateBundle } from "../../bundle/validateBundle.js";
import { findVariableLoops } from "../../bundle/variableLoops.js";

/**
 * Variable loops (#228) through the real CLI: for each case, the inspector reads the
 * structural preview (no target, as the Problems panel does) and says what each target
 * gets; `bundle validate -t <target>` against a fake workspace on 127.0.0.1 says what it
 * really does. They must agree, so a CLI release that changes how it follows variables
 * fails here. No login: an empty config file and a made-up token.
 */

const execFileAsync = promisify(execFile);
const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";

type Verdict = "error" | "warning" | "ok";

const TARGETS = "targets:\n  dev:\n    default: true\n  prod: {}\n";
const CASES: Record<string, string> = {
  pair: "variables:\n  a:\n    default: ${var.b}\n  b:\n    default: ${var.a}\n" + TARGETS,
  self: "variables:\n  a:\n    default: ${var.a}\n" + TARGETS,
  in_text: "variables:\n  a:\n    default: pre_${var.b}\n  b:\n    default: ${var.a}_x\n" + TARGETS,
  three_way: "variables:\n  a:\n    default: ${var.b}\n  b:\n    default: ${var.c}\n  c:\n    default: ${var.a}\n" + TARGETS,
  chain_ok: "variables:\n  a:\n    default: ${var.b}\n  b:\n    default: ${var.c}\n  c:\n    default: main\n" + TARGETS,
  unused_loop: "variables:\n  a:\n    default: main\n  x:\n    default: ${var.y}\n  y:\n    default: ${var.x}\n" + TARGETS,
  target_only:
    "variables:\n  a:\n    default: main\n  b:\n    default: ${var.a}\ntargets:\n  dev:\n    default: true\n    variables:\n      a: ${var.b}\n  prod: {}\n",
  target_breaks:
    "variables:\n  a:\n    default: ${var.b}\n  b:\n    default: ${var.a}\ntargets:\n  dev:\n    default: true\n    variables:\n      b: main\n  prod: {}\n",
  field: "variables:\n  a:\n    type: complex\n    default:\n      x: ${var.b}\n  b:\n    default: ${var.a.x}\n" + TARGETS,
  field_no_loop:
    "variables:\n  a:\n    type: complex\n    default:\n      x: main\n      y: ${var.b}\n  b:\n    default: ${var.a.x}\n" + TARGETS,
  complex_self: "variables:\n  a:\n    type: complex\n    default:\n      hello: ${var.a}\n" + TARGETS,
  complex_mixed: "variables:\n  a:\n    type: complex\n    default:\n      hello: ${var.b}\n  b:\n    default: ${var.a}\n" + TARGETS,
};

let server: http.Server;
let host: string;
let root: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url?.split("?")[0] ?? "";
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        url.endsWith("/scim/v2/Me")
          ? { id: "1", userName: "tester@example.com" }
          : url.endsWith("/workspace/get-status")
            ? { object_type: "DIRECTORY", path: "/" }
            : {},
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = mkdtempSync(path.join(os.tmpdir(), "dbi-variable-loops-"));
  writeFileSync(path.join(root, "empty.cfg"), "");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

function writeCase(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir);
  writeFileSync(
    path.join(dir, "databricks.yml"),
    `bundle:\n  name: loops_${name}\n${CASES[name]}workspace:\n  host: ${host}\n`,
  );
  return dir;
}

async function cliVerdict(dir: string, target: string): Promise<Verdict> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DATABRICKS_")));
  let output: string;
  try {
    const { stderr } = await execFileAsync(cli, ["bundle", "validate", "-t", target, "-o", "json"], {
      cwd: dir,
      timeout: 60_000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...env, DATABRICKS_CONFIG_FILE: path.join(root, "empty.cfg"), DATABRICKS_TOKEN: "not-a-real-token" },
    });
    output = stderr;
  } catch (error) {
    output = (error as { stderr?: string }).stderr ?? "";
  }
  if (/cycle detected in field resolution/.test(output)) return "error";
  if (/Variables references are too deep/.test(output)) return "warning";
  // Anything else would mean the fake workspace didn't get the CLI as far as variables.
  expect(output).not.toMatch(/^Error:/m);
  return "ok";
}

describe(`variable loops match the CLI (${cli})`, () => {
  test.each(Object.keys(CASES))("%s", async (name) => {
    const dir = writeCase(name);
    const preview = await validateBundle(dir, undefined, cli);
    if (!preview.ok) throw new Error(JSON.stringify(preview.error));
    const loops = findVariableLoops(preview.data);
    const inspector = (target: string): Verdict => {
      const hits = loops.filter((loop) => loop.everyTarget || loop.targets.includes(target));
      if (hits.some((loop) => !loop.complex)) return "error";
      return hits.length > 0 ? "warning" : "ok";
    };
    const rows: Array<[string, Verdict, Verdict]> = [];
    for (const target of ["dev", "prod"]) rows.push([target, await cliVerdict(dir, target), inspector(target)]);
    // [target, CLI, inspector]
    expect(rows.filter(([, fromCli, fromInspector]) => fromCli !== fromInspector)).toEqual([]);
  });
});
