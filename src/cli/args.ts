/** The command line: one command, `check`, and its options (#348). */

import { parseArgs } from "node:util";

export const FORMATS = ["text", "json", "markdown", "github"] as const;
export type Format = (typeof FORMATS)[number];

export const FAIL_ON = ["error", "warning", "note", "never"] as const;
export type FailOn = (typeof FAIL_ON)[number];

export interface CheckOptions {
  command: "check";
  paths: string[];
  format: Format;
  failOn: FailOn;
  output: string | undefined;
  color: boolean;
  databricksCli: string | undefined;
  /** A real target to check instead of the structural preview. Needs a sign-in. */
  target: string | undefined;
  /** The `~/.databrickscfg` profile for `target`. */
  profile: string | undefined;
}

export type ParsedArgs =
  | CheckOptions
  | { command: "help" }
  | { command: "version" }
  | { command: "usage_error"; message: string };

export const HELP = `Usage: databricks-bundle-inspector check [paths...] [options]

Checks every Databricks bundle (databricks.yml or databricks.yaml) under the paths, or under
the current folder. Runs only \`databricks bundle validate\`, with the bundle's own scripts
and Python turned off. Nothing is deployed, planned or run, and nothing is written into the
bundle folders.

Options:
  --format <text|json|markdown|github>   How to print the findings (default: text)
  --fail-on <error|warning|note|never>   Exit with 1 when a finding is at least this
                                         severe (default: error)
  --output <file>                        Write the report to a file instead of the terminal
  --databricks-cli <path>                The Databricks CLI to run (default: databricks
                                         on PATH)
  -t, --target <name>                    Check this target as the Databricks CLI resolves it
                                         (default: the structural preview, no sign-in).
                                         Needs a sign-in to the target's workspace
  -p, --profile <name>                   The ~/.databrickscfg profile for --target
  --no-color                             Plain text, no colours
  -h, --help                             Show this help
  -v, --version                          Show the version

Exit codes:
  0  nothing at or above --fail-on
  1  findings at or above --fail-on, including errors the Databricks CLI reports
  2  wrong usage
  3  setup problem: no Databricks CLI, one older than v0.299.0, or no working
     sign-in for --target
  4  the inspector itself failed
`;

function oneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

/** Reads the arguments after the program name. Never throws: wrong usage comes back as `usage_error`. */
export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        format: { type: "string" },
        "fail-on": { type: "string" },
        output: { type: "string" },
        "databricks-cli": { type: "string" },
        target: { type: "string", short: "t" },
        profile: { type: "string", short: "p" },
        "no-color": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    return { command: "usage_error", message: error instanceof Error ? error.message : String(error) };
  }
  const { values, positionals } = parsed;
  if (values.help) return { command: "help" };
  if (values.version) return { command: "version" };

  const [command, ...paths] = positionals;
  if (command === undefined) return { command: "usage_error", message: "Missing a command. Try: databricks-bundle-inspector check" };
  if (command === "help") return { command: "help" };
  if (command !== "check") return { command: "usage_error", message: `Unknown command "${command}". The command is: check` };

  const format = values.format ?? "text";
  if (!oneOf(format, FORMATS)) return { command: "usage_error", message: `--format must be one of: ${FORMATS.join(", ")}` };
  const failOn = values["fail-on"] ?? "error";
  if (!oneOf(failOn, FAIL_ON)) return { command: "usage_error", message: `--fail-on must be one of: ${FAIL_ON.join(", ")}` };
  for (const [name, value] of [
    ["--output", values.output],
    ["--databricks-cli", values["databricks-cli"]],
    ["--target", values.target],
    ["--profile", values.profile],
  ] as const) {
    if (value !== undefined && value.trim() === "") return { command: "usage_error", message: `${name} needs a value` };
  }

  if (values.profile !== undefined && values.target === undefined) {
    return { command: "usage_error", message: "--profile is for --target: the structural preview needs no sign-in" };
  }

  // https://no-color.org: any non-empty NO_COLOR turns colour off.
  const color = !values["no-color"] && !env.NO_COLOR;
  return {
    command: "check",
    paths: paths.length > 0 ? paths : ["."],
    format,
    failOn,
    output: values.output,
    color,
    databricksCli: values["databricks-cli"],
    target: values.target?.trim(),
    profile: values.profile?.trim(),
  };
}
