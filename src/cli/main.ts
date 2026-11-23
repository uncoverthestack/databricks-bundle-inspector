/** The command-line tool's entry point (#348): arguments in, a report and an exit code out. */

import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HELP, parseCliArgs, type CheckOptions } from "./args.js";
import { checkBundles, findDatabricksCli } from "./check.js";
import { discoverBundles } from "./discover.js";
import { exitCodeFor, formatMarkdown, formatReport } from "./formats.js";

export const EXIT = { ok: 0, findings: 1, usage: 2, setup: 3, failed: 4 } as const;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Whether stdout is a terminal, so colour is only used where it shows. */
  isTty: boolean;
}

declare const __CLI_VERSION__: string | undefined;
export const VERSION = typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0-dev";

/**
 * The core logs progress with console.log for the extension's output channel. Here stdout is the
 * report, so those messages go nowhere.
 */
function silenceCoreLogs(): () => void {
  const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
  console.log = console.info = console.debug = console.warn = () => {};
  return () => Object.assign(console, saved);
}

async function check(options: CheckOptions, io: CliIo): Promise<number> {
  const discovery = discoverBundles(options.paths, io.cwd);
  if (!discovery.ok) {
    io.stderr(`${discovery.message}\n`);
    return EXIT.usage;
  }
  const cli = await findDatabricksCli(options.databricksCli, io.cwd);
  if (!cli.ok) {
    io.stderr(`${cli.message}\n`);
    return EXIT.setup;
  }
  const outcome = await checkBundles(discovery.roots, { path: cli.path, version: cli.version }, io.cwd, VERSION, {
    target: options.target,
    profile: options.profile,
  });
  if (!outcome.ok) {
    io.stderr(`${outcome.message}\n`);
    return outcome.kind === "usage" ? EXIT.usage : EXIT.setup;
  }
  const text = formatReport(outcome.report, options.format, options.failOn, options.color && !options.output && io.isTty);
  if (options.output) writeFileSync(path.resolve(io.cwd, options.output), text);
  else io.stdout(text);
  // In GitHub Actions, the markdown report also goes on the run's summary page.
  if (options.format === "github" && io.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(io.env.GITHUB_STEP_SUMMARY, formatMarkdown(outcome.report));
  }
  return exitCodeFor(outcome.report, options.failOn);
}

/** Runs one command. Returns the exit code; never throws. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const args = parseCliArgs(argv, io.env);
  switch (args.command) {
    case "help":
      io.stdout(HELP);
      return EXIT.ok;
    case "version":
      io.stdout(`${VERSION}\n`);
      return EXIT.ok;
    case "usage_error":
      io.stderr(`${args.message}\n\n${HELP}`);
      return EXIT.usage;
    case "check": {
      const restore = silenceCoreLogs();
      try {
        return await check(args, io);
      } catch (error) {
        io.stderr(`The inspector failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        return EXIT.failed;
      } finally {
        restore();
      }
    }
  }
}
