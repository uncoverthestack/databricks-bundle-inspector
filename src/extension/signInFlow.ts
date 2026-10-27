import * as vscode from "vscode";
import { accessSync, constants, existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SIGN_IN_CODES, type FallbackCode } from "../bundle/fallbackReason.js";
import {
  isSafeHost,
  parseConfigSections,
  planSignIn,
  profileUpdated,
  signInCommand,
  targetWorkspace,
  terminalCli,
  type ConfigSections,
  type SignInPlan,
} from "../databricksCli/signIn.js";

/**
 * Where a sign-in for a target stands, as the graph's banner shows it. One state at a time:
 * `needed` (the target fell back for want of a sign-in), `terminal` (the command is typed,
 * waiting for Enter), `updated` (the CLI saved the profile; nothing checks by itself),
 * `checking` (the user asked to check the target again).
 */
export type SignInStage = "needed" | "terminal" | "updated" | "checking";

export interface SignInBanner {
  target: string;
  stage: SignInStage;
  /** Why the terminal isn't offered, when signing in here would be unsafe or can't work. */
  blockedReason?: string;
}

interface Flow {
  root: string;
  target: string;
  stage: SignInStage;
  blockedReason?: string;
  /** Between a click and the terminal opening, so a second click opens no second terminal. */
  opening?: boolean;
  /** Set once the terminal is open: what is watched. */
  watch?: { watcher: FSWatcher };
}

export interface SignInDeps {
  /** The files of the bundle that can define its targets: the bundle file, then what `include` loads. */
  bundleFiles(root: string): string[];
  /** The `databricksBundleInspector.profile` setting, which the checks of a real target use. */
  configuredProfile(): string | undefined;
  /** The CLI file the checks run, for the terminal's PATH. Undefined when it is found by name. */
  cliFile(): Promise<string | undefined>;
  /** The banner changed: post it to the graph and refresh the sidebar. */
  changed(root: string, banner: SignInBanner | undefined): void;
  telemetry(step: "terminal_opened" | "profile_updated", from?: "graph" | "sidebar"): void;
}

/** The file `auth login` saves profiles in: `DATABRICKS_CONFIG_FILE`, else `~/.databrickscfg`. */
export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.DATABRICKS_CONFIG_FILE?.trim();
  if (!set) return path.join(os.homedir(), ".databrickscfg");
  return set.startsWith("~/") ? path.join(os.homedir(), set.slice(2)) : set;
}

/** The sign-in for the target the graph shows; one at a time, as there is one graph. */
export class SignInFlow implements vscode.Disposable {
  private flow: Flow | undefined;

  constructor(private readonly deps: SignInDeps) {}

  /**
   * The banner for a target that fell back, or undefined when signing in can't fix the
   * reason. The same target keeps its stage across refreshes; a new target, or a check
   * asked for that failed again, starts over. Before the terminal opens, each refresh
   * plans again, so a fixed config file or bundle unblocks it.
   */
  bannerFor(root: string, target: string, code: FallbackCode | undefined): SignInBanner | undefined {
    if (!code || !SIGN_IN_CODES.has(code)) {
      this.reset();
      return undefined;
    }
    const same = this.flow && this.flow.root === root && this.flow.target === target;
    if (!same || this.flow!.stage === "checking") {
      this.reset();
      this.flow = { root, target, stage: "needed" };
    }
    if (this.flow!.stage === "needed") this.setBlocked(this.flow!, this.plan(root, target));
    return this.banner();
  }

  /** The current banner of a bundle, for the sidebar. */
  bannerOf(root: string): SignInBanner | undefined {
    return this.flow?.root === root ? this.banner() : undefined;
  }

  /** The target checked fine, or the graph moved on: no banner. */
  reset(): void {
    this.flow?.watch?.watcher.close();
    this.flow = undefined;
  }

  /** Check the target again was clicked: the banner says so until the check ends. */
  markChecking(root: string, target: string): void {
    if (this.flow?.root !== root || this.flow.target !== target) return;
    this.flow.watch?.watcher.close();
    delete this.flow.watch;
    this.flow.stage = "checking";
    this.deps.changed(root, this.banner());
  }

  /**
   * Types `databricks auth login` into a new terminal without running it. Asks for the
   * workspace URL when the bundle doesn't give one. Nothing is typed when the profile would
   * be replaced or the config file can't be read or written. Plans again on each click.
   */
  async openTerminal(root: string, target: string, from: "graph" | "sidebar"): Promise<void> {
    const flow = this.flow;
    if (!flow || flow.root !== root || flow.target !== target || flow.opening) return;
    flow.opening = true;
    try {
      await this.open(flow, from);
    } finally {
      flow.opening = false;
    }
  }

  private async open(flow: Flow, from: "graph" | "sidebar"): Promise<void> {
    const { root, target } = flow;
    const configFile = configFilePath();
    if (!canWrite(configFile)) {
      flow.blockedReason = `${configFile} can't be written, and the Databricks CLI saves your sign-in there`;
      this.deps.changed(root, this.banner());
      return;
    }
    let plan = this.plan(root, target);
    if (plan.kind === "needs_host") {
      const host = await vscode.window.showInputBox({
        title: `Sign in to check ${target}`,
        prompt: `The workspace URL ${target} uses, as in your browser's address bar`,
        placeHolder: "https://adb-1234567890123456.7.azuredatabricks.net",
        ignoreFocusOut: true,
        validateInput: (value) =>
          isSafeHost(value.trim()) ? undefined : "An https:// address, such as https://adb-1234.7.azuredatabricks.net",
      });
      if (!host || this.flow !== flow) return;
      plan = this.plan(root, target, host.trim());
    }
    this.setBlocked(flow, plan);
    if (plan.kind !== "ready") {
      this.deps.changed(root, this.banner());
      return;
    }

    const cliFile = await this.deps.cliFile();
    if (this.flow !== flow) return;
    // The CLI the checks use: first on PATH when it is named `databricks`, else typed as its path.
    const cli = cliFile ? terminalCli(cliFile) : { command: "databricks" };
    if (!cli) {
      flow.blockedReason = `the Databricks CLI file in Settings, ${cliFile}, has characters a terminal would read`;
      this.deps.changed(root, this.banner());
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: "Databricks sign-in",
      cwd: root,
      ...("folder" in cli ? { env: { [pathKey()]: `${cli.folder}${path.delimiter}${process.env[pathKey()] ?? ""}` } } : {}),
    });
    terminal.show();
    // Typed, not run: the user reads it and presses Enter.
    terminal.sendText(signInCommand(plan.host, plan.profile, cli.command), false);
    this.watchProfile(flow, configFile, plan);
    flow.stage = "terminal";
    this.deps.telemetry("terminal_opened", from);
    this.deps.changed(root, this.banner());
  }

  dispose(): void {
    this.reset();
  }

  private banner(): SignInBanner | undefined {
    const flow = this.flow;
    if (!flow) return undefined;
    return { target: flow.target, stage: flow.stage, ...(flow.blockedReason ? { blockedReason: flow.blockedReason } : {}) };
  }

  private setBlocked(flow: Flow, plan: SignInPlan): void {
    if (plan.kind === "blocked") flow.blockedReason = plan.reason;
    else delete flow.blockedReason;
  }

  private plan(root: string, target: string, askedHost?: string): SignInPlan {
    const texts = this.deps.bundleFiles(root).flatMap((file) => {
      try {
        return [readFileSync(file, "utf8")];
      } catch {
        return [];
      }
    });
    const workspace = targetWorkspace(texts, target);
    const config = readConfig(configFilePath());
    if ("reason" in config) return { kind: "blocked", reason: config.reason };
    return planSignIn({
      host: askedHost ?? workspace.host,
      profile: this.deps.configuredProfile() ?? workspace.profile,
      sections: config.sections,
    });
  }

  /** Watches the folder of the config file: the CLI replaces the file, which a watch on the file itself can miss. */
  private watchProfile(flow: Flow, configFile: string, plan: Extract<SignInPlan, { kind: "ready" }>): void {
    flow.watch?.watcher.close();
    const backup = `${configFile}.bak`;
    const read = () => {
      const config = readConfig(configFile);
      return "sections" in config ? config.sections : undefined;
    };
    // What the file was at the last change that wasn't this sign-in, so a sign-in to another
    // profile in between doesn't hide this one's.
    let before = read() ?? new Map();
    let backupTime = modifiedTime(backup);
    let timer: NodeJS.Timeout | undefined;
    const watcher = watch(path.dirname(configFile), (_event, name) => {
      const changed = name?.toString();
      if (changed && changed !== path.basename(configFile) && changed !== path.basename(backup)) return;
      clearTimeout(timer);
      // The CLI writes the file and its copy one after the other: read once both are done.
      timer = setTimeout(() => {
        if (this.flow !== flow || flow.stage !== "terminal") return;
        const after = read();
        const time = modifiedTime(backup);
        if (!after) return;
        if (!profileUpdated({ before, after, profile: plan.profile, host: plan.host, backupChanged: time !== backupTime })) {
          before = after;
          backupTime = time;
          return;
        }
        watcher.close();
        flow.stage = "updated";
        this.deps.telemetry("profile_updated");
        this.deps.changed(flow.root, this.banner());
      }, 300);
    });
    watcher.on("error", () => watcher.close());
    flow.watch = { watcher };
  }
}

/**
 * The profiles in the config file: none when there is no file yet, and a reason when it
 * can't be read or has a line the CLI can't read, as then no name is known to be safe.
 */
function readConfig(file: string): { sections: ConfigSections } | { reason: string } {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sections: new Map() };
    return { reason: `${file} can't be read, so it isn't known which sign-in profiles it holds` };
  }
  const sections = parseConfigSections(text);
  return sections ? { sections } : { reason: `${file} has a line the Databricks CLI can't read` };
}

function modifiedTime(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** The CLI rewrites the file and writes a `.bak` beside it, so both need the folder writable. */
function canWrite(file: string): boolean {
  try {
    if (existsSync(file)) accessSync(file, constants.W_OK);
    accessSync(path.dirname(file), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** `Path` on Windows, as the environment spells it there. */
function pathKey(): string {
  return Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}
