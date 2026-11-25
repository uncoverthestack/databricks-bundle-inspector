import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseCliArgs } from "../../../cli/args.js";
import { cliErrorLine, findingFromIssue, findingsFromFailedValidate, type CheckReport, type Finding } from "../../../cli/check.js";
import {
  escapeCommandData,
  escapeCommandProperty,
  exitCodeFor,
  failsOn,
  formatGithub,
  formatJson,
  formatMarkdown,
  formatReport,
  formatText,
  neutraliseCommands,
  orderFindings,
  summaryLine,
} from "../../../cli/formats.js";

/** A finding; an override set to undefined leaves that field out. */
const finding = (overrides: { [K in keyof Finding]?: Finding[K] | undefined } = {}): Finding => {
  const merged: Record<string, unknown> = {
    severity: "error",
    code: "missing_file",
    message: "File not found: ./src/a.py",
    file: "bundle/databricks.yml",
    line: 12,
    column: 5,
    docs: "https://example.test/docs/checks.md#missing_file",
    ...overrides,
  };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as unknown as Finding;
};

const report = (findings: Finding[], extra: Partial<CheckReport> = {}): CheckReport => ({
  version: "1.2.3",
  databricksCli: { path: "/usr/local/bin/databricks", version: "v1.27.0" },
  bundles: [{ path: "bundle", name: "demo", validated: true, findings }],
  ...extra,
});

describe("arguments (#348)", () => {
  test("check with defaults: current folder, text, fail on errors, colour", () => {
    expect(parseCliArgs(["check"], {})).toEqual({
      command: "check",
      paths: ["."],
      format: "text",
      failOn: "error",
      output: undefined,
      color: true,
      databricksCli: undefined,
      target: undefined,
      profile: undefined,
    });
  });

  test("a real target and its profile", () => {
    expect(parseCliArgs(["check", "-t", "prod", "-p", "PROD"], {})).toMatchObject({ target: "prod", profile: "PROD" });
    expect(parseCliArgs(["check", "--target", "dev"], {})).toMatchObject({ target: "dev", profile: undefined });
  });

  test("every option", () => {
    expect(
      parseCliArgs(["check", "a", "b/databricks.yml", "--format", "github", "--fail-on", "warning", "--output", "r.md", "--databricks-cli", "/x/databricks", "--no-color"], {}),
    ).toEqual({
      command: "check",
      paths: ["a", "b/databricks.yml"],
      format: "github",
      failOn: "warning",
      output: "r.md",
      color: false,
      databricksCli: "/x/databricks",
      target: undefined,
      profile: undefined,
    });
  });

  test("NO_COLOR turns colour off", () => {
    expect(parseCliArgs(["check"], { NO_COLOR: "1" })).toMatchObject({ color: false });
    expect(parseCliArgs(["check"], { NO_COLOR: "" })).toMatchObject({ color: true });
  });

  test("help and version", () => {
    expect(parseCliArgs(["--help"], {})).toEqual({ command: "help" });
    expect(parseCliArgs(["-h"], {})).toEqual({ command: "help" });
    expect(parseCliArgs(["help"], {})).toEqual({ command: "help" });
    expect(parseCliArgs(["--version"], {})).toEqual({ command: "version" });
    expect(parseCliArgs(["check", "-v"], {})).toEqual({ command: "version" });
  });

  test.each([
    [[], "Missing a command"],
    [["deploy"], 'Unknown command "deploy"'],
    [["check", "--format", "sarif"], "--format must be one of"],
    [["check", "--fail-on", "info"], "--fail-on must be one of"],
    [["check", "--sarif"], "Unknown option"],
    [["check", "--profile", "DEV"], "--profile is for --target"],
    [["check", "--target", ""], "--target needs a value"],
    [["check", "--output", " "], "--output needs a value"],
    [["check", "--format"], "argument missing"],
  ])("wrong usage %j", (argv, message) => {
    const parsed = parseCliArgs(argv, {});
    expect(parsed.command).toBe("usage_error");
    expect((parsed as { message: string }).message).toContain(message);
  });
});

describe("failing and exit codes (#348)", () => {
  test("each --fail-on level", () => {
    expect(["error", "warning", "info"].map((s) => failsOn(s as Finding["severity"], "error"))).toEqual([true, false, false]);
    expect(["error", "warning", "info"].map((s) => failsOn(s as Finding["severity"], "warning"))).toEqual([true, true, false]);
    expect(["error", "warning", "info"].map((s) => failsOn(s as Finding["severity"], "note"))).toEqual([true, true, true]);
    expect(["error", "warning", "info"].map((s) => failsOn(s as Finding["severity"], "never"))).toEqual([false, false, false]);
  });

  test("the exit code follows the worst finding", () => {
    const warningOnly = report([finding({ severity: "warning" })]);
    expect(exitCodeFor(warningOnly, "error")).toBe(0);
    expect(exitCodeFor(warningOnly, "warning")).toBe(1);
    expect(exitCodeFor(report([]), "note")).toBe(0);
    expect(exitCodeFor(report([finding()]), "never")).toBe(0);
  });

  test("findings are ordered errors first, then by file and line", () => {
    const ordered = orderFindings([
      finding({ severity: "info", file: "a", line: 1 }),
      finding({ severity: "error", file: "b", line: 9 }),
      finding({ severity: "error", file: "b", line: 2 }),
      finding({ severity: "warning", file: undefined, line: undefined }),
    ]);
    expect(ordered.map((f) => `${f.severity}:${f.file}:${f.line}`)).toEqual(["error:b:2", "error:b:9", "warning:undefined:undefined", "info:a:1"]);
  });

  test("the summary line", () => {
    expect(summaryLine(report([finding(), finding({ severity: "info" })]))).toBe("1 error, 0 warnings and 1 note in 1 bundle (the structural preview)");
    expect(summaryLine(report([], { target: "prod" }))).toBe('0 errors, 0 warnings and 0 notes in 1 bundle (target "prod")');
  });
});

describe("formats (#348)", () => {
  test("text: location, message and check, then a summary; colour only when asked", () => {
    const text = formatText(report([finding()]), false);
    expect(text).toBe(
      "bundle (demo)\n  error   bundle/databricks.yml:12:5  File not found: ./src/a.py  [missing_file]\n\n1 error, 0 warnings and 0 notes in 1 bundle (the structural preview)\n",
    );
    expect(formatText(report([finding()]), true)).toContain("\x1b[31merror  \x1b[0m");
    expect(formatText(report([]), false)).toContain("  no problems");
  });

  test("text: control characters from a bundle never reach the terminal", () => {
    const text = formatText(report([finding({ message: "a\x1b[2Jb\x07c\nd" })]), false);
    expect(text).toContain("ab");
    expect(text).not.toMatch(/\x1b\[2J|\x07/);
    expect(text).toContain("c d");
  });

  test("text: a bundle that failed validate says so", () => {
    const text = formatText({ ...report([]), bundles: [{ path: "x", validated: false, findings: [finding({ code: "cli_diagnostic" })] }] }, false);
    expect(text).toContain("bundle validate failed");
  });

  test("json: a schema version, counts and every finding", () => {
    const json = JSON.parse(formatJson(report([finding(), finding({ severity: "warning" })]), "error"));
    expect(json).toMatchObject({
      schemaVersion: 1,
      tool: { name: "databricks-bundle-inspector", version: "1.2.3" },
      databricksCli: { version: "v1.27.0" },
      failOn: "error",
      target: null,
      summary: { errors: 1, warnings: 1, notes: 0, bundles: 1 },
    });
    expect(JSON.parse(formatJson(report([], { target: "prod" }), "error")).target).toBe("prod");
    expect(json.bundles[0].findings).toHaveLength(2);
    expect(JSON.stringify(json)).not.toContain("/usr/local/bin");
  });

  test("markdown: names, messages and paths from a bundle are text, never links, HTML or mentions", () => {
    const md = formatMarkdown({
      ...report([finding({ message: "[click](https://e.test) <img src=x> @team", file: "a`b|c.yml" })]),
      bundles: [{ path: "bundle", name: "@org/x [y](z)", validated: true, findings: [finding({ message: "[click](https://e.test) <img src=x> @team", file: "a`b|c.yml" })] }],
    });
    expect(md).toContain("\\[click\\](https:\u200b//e.test) &lt;img src=x&gt; @​team");
    expect(md).toContain("(@​org/x \\[y\\](z))");
    expect(md).toContain("`` a`b\\|c.yml:12:5 ``");
    expect(md).toContain("[missing\\_file](https://example.test/docs/checks.md#missing_file)");
  });

  test("github: one annotation per finding, on its file and line", () => {
    expect(formatGithub(report([finding(), finding({ severity: "info", file: undefined, line: undefined, column: undefined, message: "Bundle-wide" })]))).toBe(
      [
        // A message keeps its `:`; only properties escape it.
        "::error file=bundle/databricks.yml,line=12,col=5,title=missing_file (bundle)::File not found: ./src/a.py",
        "::notice title=missing_file (bundle)::Bundle-wide (bundle (demo))",
        "Databricks Bundle Inspector: 1 error, 0 warnings and 1 note in 1 bundle (the structural preview)",
        "",
      ].join("\n"),
    );
  });

  test("github: text from a bundle can't end the command, start another, or mention anyone", () => {
    const out = formatGithub(
      report([finding({ message: "bad\n::error::injected\r\n%0A @team", file: "a,b:c\n::warning::x.yml" })]),
    );
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.startsWith("::"))).toHaveLength(1);
    expect(lines[0]).toContain("file=a%2Cb%3Ac%0A%3A%3Awarning%3A%3Ax.yml");
    expect(lines[0]).toContain("::bad%0A::error::injected%0D%0A%250A @​team");
  });

  test("GitHub's escaping rules", () => {
    expect(escapeCommandData("50% a\r\nb")).toBe("50%25 a%0D%0Ab");
    expect(escapeCommandProperty("a:b,c%")).toBe("a%3Ab%2Cc%25");
  });

  test("other formats never print a line that GitHub would run as a command", () => {
    const tricky = report([finding({ message: "x", file: "::error::f" })], {
      bundles: [{ path: "::add-mask::secret", name: "::stop-commands::t", validated: true, findings: [finding({ message: "\n::error::m" })] }],
    });
    for (const format of ["text", "json", "markdown"] as const) {
      const out = formatReport(tricky, format, "error", false);
      expect(out.split("\n").filter((line) => /^\s*::/.test(line))).toEqual([]);
    }
    expect(neutraliseCommands("::a\n  ::b\nok :: c")).toBe(":​:a\n  :​:b\nok :: c");
  });
});

describe("a failed bundle validate (#348)", () => {
  const failed = (diagnostics: Array<{ severity: "error" | "warning"; message: string; path?: string; line?: number }>, details?: string) => ({
    ok: false as const,
    error: { bundleDir: "/b", bundleName: "b", error: "Failed to validate Databricks bundle.", ...(details ? { details } : {}), diagnostics },
  });

  test("always fails: when the CLI printed only warnings, its failure is an error too", () => {
    const findings = findingsFromFailedValidate(failed([{ severity: "warning", message: "odd", path: "databricks.yml", line: 3 }], "warning: odd\nerror: boom"), "/b", "/b", "1.0.0");
    expect(findings.map((f) => `${f.severity}:${f.message}`)).toEqual(["error:Failed to validate Databricks bundle. boom", "warning:odd"]);
  });

  test("an error diagnostic is enough on its own", () => {
    const findings = findingsFromFailedValidate(failed([{ severity: "error", message: "bad" }]), "/b", "/b", "1.0.0");
    expect(findings.map((f) => `${f.severity}:${f.message}`)).toEqual(["error:bad"]);
  });

  test("the CLI's error line, not a warning before it", () => {
    expect(cliErrorLine("warning: x\nerror: the reason\nmore")).toBe("the reason");
    expect(cliErrorLine("just one line")).toBe("just one line");
  });
});

describe("findings in the command line's words (#348)", () => {
  test("a path that uses a variable says to check it with --target, not in the graph", () => {
    const finding = findingFromIssue(
      { id: "1", severity: "info", kind: "path_not_checked", title: 'Not checked: "${var.nb}" uses a variable, so the file isn\'t known yet. Pick a target in the graph to check it.' },
      "/b",
      "1.0.0",
    );
    expect(finding.message).toBe('Not checked: "${var.nb}" uses a variable, so the file isn\'t known yet. Use --target to check it.');
  });

  test("other findings keep their words", () => {
    const title = "Pick a target in the graph to check it.";
    expect(findingFromIssue({ id: "1", severity: "info", kind: "unused_parameter", title }, "/b", "1.0.0").message).toBe(title);
  });
});

describe("the npm package (#348)", () => {
  test("has the extension's version, so one tag publishes both", () => {
    const root = path.resolve(__dirname, "../../../..");
    const extension = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const cli = JSON.parse(readFileSync(path.join(root, "cli/package.json"), "utf8"));
    expect(cli.version).toBe(extension.version);
    expect(cli.engines.node).toBe(">=22");
    expect(cli.dependencies ?? {}).toEqual({});
    expect(cli.bin).toEqual({ "databricks-bundle-inspector": "dist/cli.cjs", dabi: "dist/cli.cjs" });
  });
});
