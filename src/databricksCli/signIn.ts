import path from "node:path";
import { isScalar, parseDocument } from "yaml";
import { anchorsOf, entries } from "../bundle/variableSources.js";

/**
 * Signing in for a target: the extension types `databricks auth login` into a terminal and
 * never runs it; the user presses Enter. No VS Code types here, so every rule is tested.
 * Rules from testing `auth login` on CLI 0.299.0, 1.21.0 and 1.22.0 with a fake workspace
 * (issue #245):
 *
 * - Signing in under the name of a profile that doesn't use browser sign-in rewrites it as
 *   a browser profile and deletes its token. Such a name is never suggested.
 * - `--profile` is always passed: without it no profile is written.
 * - `--timeout` is left out: CLI versions before 1.22.0 ignore it.
 * - The CLI rewrites the whole config file and keeps a `.bak` copy beside it.
 */

/** One `[section]` of the config file, keys lower-cased. */
export type ConfigSection = Record<string, string>;

/** Every section of a `.databrickscfg` file, by name as written. */
export type ConfigSections = Map<string, ConfigSection>;

/**
 * The sections of a `.databrickscfg` file, or undefined when a line isn't one the CLI reads,
 * as then nobody can say which profiles it holds. Read from the file, not `databricks auth
 * profiles`, which leaves out a profile with no host (checked on CLI 0.299.0 and 1.21.0),
 * though signing in under its name would still replace it. Read as `auth profiles` reads it
 * on CLI 0.299.0 and 1.21.0: keys before the first `[section]` are the DEFAULT profile, a
 * section name ends at the line's last `]` (so `[a] # note` is `a`) and keeps its spaces,
 * `:` works as `=`, and a line with neither makes the CLI refuse the whole file.
 */
export function parseConfigSections(text: string): ConfigSections | undefined {
  const sections: ConfigSections = new Map();
  let current: ConfigSection | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const close = line.lastIndexOf("]");
      if (close <= 1) return undefined;
      const name = line.slice(1, close);
      current = sections.get(name) ?? {};
      sections.set(name, current);
      continue;
    }
    const delimiter = line.search(/[=:]/);
    if (delimiter <= 0) return undefined;
    if (!current) {
      current = sections.get("DEFAULT") ?? {};
      sections.set("DEFAULT", current);
    }
    const key = line.slice(0, delimiter).trim().toLowerCase();
    // An inline comment starts with a space then ; or #, as the CLI's ini reader reads it.
    let value = line.slice(delimiter + 1).replace(/\s[;#].*$/, "").trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!)) value = value.slice(1, -1);
    current[key] = value;
  }
  return sections;
}

/** A section that signs in through the browser: what `auth login` writes. */
export function isBrowserSignIn(section: ConfigSection | undefined): boolean {
  return section?.auth_type?.toLowerCase() === "databricks-cli";
}

/** `https://host[:port]`, lower-cased, for comparing workspaces. Undefined when not a URL. */
export function workspaceOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  try {
    const url = new URL(host.includes("://") ? host : `https://${host}`);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * A workspace URL that can go inside double quotes in zsh, bash, PowerShell and cmd as it
 * is: `https://`, a host name, an optional port, `/`, and a query such as `?o=123`. No `$`,
 * `%`, `!`, quotes, backticks or spaces, which one of those shells would read.
 */
export function isSafeHost(host: string): boolean {
  return /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?\/?(?:\?[A-Za-z0-9_=&-]{1,200})?$/.test(host);
}

/** A profile name that can go inside double quotes in those shells, as `isSafeHost`. */
export function isSafeProfileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 ._@+-]{0,63}$/.test(name) && name.toLowerCase() !== "__settings__";
}

/** The command typed into the terminal. Both values are checked first and double-quoted. */
export function signInCommand(host: string, profile: string, cli = "databricks"): string {
  return `${cli} auth login --host "${host}" --profile "${profile}"`;
}

/**
 * How the terminal runs the CLI file the checks use. A file named `databricks` (with
 * `.exe`, `.cmd` or `.bat` on Windows) is found by name once its folder is first on PATH.
 * Another name is typed as its path, which every one of those shells runs as it is when it
 * has no spaces or characters a shell would read. Undefined when it has them.
 */
export function terminalCli(
  cliFile: string,
  platform: NodeJS.Platform = process.platform,
): { command: "databricks"; folder: string } | { command: string } | undefined {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const base = paths.basename(cliFile);
  const named = platform === "win32" ? /^databricks\.(exe|cmd|bat)$/i.test(base) : base === "databricks";
  if (named) return { command: "databricks", folder: paths.dirname(cliFile) };
  // No leading `~`, which zsh and bash would expand.
  return /^[A-Za-z0-9_./\\][A-Za-z0-9_.~/\\:+-]*$/.test(cliFile) ? { command: cliFile } : undefined;
}

/** A profile name for a new sign-in: the host's first label (`adb-1234` from `adb-1234.azuredatabricks.net`), unique in the file. */
export function newProfileName(host: string, sections: ConfigSections): string {
  let label = "";
  try {
    label = new URL(host).hostname.split(".")[0] ?? "";
  } catch {
    // Not a URL: the fallback name.
  }
  const base = label.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "databricks";
  // Names that differ only in letter case count as taken, as different tools read them differently.
  const taken = new Set([...sections.keys(), "default", "__settings__"].map((name) => name.toLowerCase()));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * The workspace a target uses, as its YAML writes it. `null` is a value with `${...}`, which
 * only the CLI fills in: not known here, and not the bundle's own value either.
 */
export interface TargetWorkspace {
  host?: string | null;
  profile?: string | null;
}

/**
 * The target's `workspace.host` and `workspace.profile`, else the bundle's top-level ones,
 * from the bundle file and the files it includes, read as the CLI reads keys (anchors,
 * merges, a repeated key where it last appears). A value that uses a variable is `null`:
 * the CLI fills it in, and the inspector would be guessing. A target's `null` still hides
 * the top-level value, as the CLI uses the target's.
 */
export function targetWorkspace(texts: readonly string[], target: string): TargetWorkspace {
  const top: TargetWorkspace = {};
  const own: TargetWorkspace = {};
  for (const text of texts) {
    let document;
    try {
      document = parseDocument(text, { uniqueKeys: false });
    } catch {
      continue;
    }
    const anchors = anchorsOf(document);
    const root = entries(anchors, document.contents);
    read(entries(anchors, root.get("workspace")?.value), top);
    const targetEntry = entries(anchors, root.get("targets")?.value).get(target);
    read(entries(anchors, entries(anchors, targetEntry?.value).get("workspace")?.value), own);
  }
  const host = own.host !== undefined ? own.host : top.host;
  const profile = own.profile !== undefined ? own.profile : top.profile;
  return { ...(host !== undefined ? { host } : {}), ...(profile !== undefined ? { profile } : {}) };

  function read(workspace: ReturnType<typeof entries>, into: TargetWorkspace): void {
    for (const key of ["host", "profile"] as const) {
      const node = workspace.get(key)?.value;
      const value = isScalar(node) && typeof node.value === "string" ? node.value.trim() : undefined;
      if (value) into[key] = value.includes("${") ? null : value;
    }
  }
}

/** What signing in for a target would do, or why it isn't offered. */
export type SignInPlan =
  /** Ready to type. `host` comes from the bundle or the profile; `reuses` when the profile exists. */
  | { kind: "ready"; host: string; profile: string; reuses: boolean }
  /** No host is known: the user is asked for the workspace URL, then the plan is made again. */
  | { kind: "needs_host"; profile?: string }
  /** Not offered, with the reason in a few words for the banner. */
  | { kind: "blocked"; reason: string };

/**
 * Which profile to sign in under, never one that would be replaced. A `null` host or profile
 * is set with a variable: an unknown host is asked for, and an unknown profile blocks, as
 * signing in under another name wouldn't be the one the checks use.
 * 1. the profile the checks use (the `profile` setting, else the target's `workspace.profile`),
 *    when it doesn't exist yet or already signs in through the browser for that workspace;
 * 2. else a browser profile that already exists for the host;
 * 3. else a new name made from the host.
 */
export function planSignIn(options: {
  host: string | null | undefined;
  profile: string | null | undefined;
  sections: ConfigSections;
}): SignInPlan {
  const { sections } = options;
  if (options.profile === null) {
    return { kind: "blocked", reason: "its profile is set with a variable, which only the Databricks CLI fills in" };
  }
  if (options.host === null) return { kind: "needs_host", ...(options.profile ? { profile: options.profile } : {}) };
  if (options.host !== undefined && !isSafeHost(options.host)) {
    return { kind: "blocked", reason: "its workspace URL isn't a plain https:// address" };
  }
  const named = options.profile;
  if (named !== undefined) {
    if (!isSafeProfileName(named)) return { kind: "blocked", reason: `the profile name "${named}" has characters a terminal would read` };
    const section = sections.get(named);
    if (section && !isBrowserSignIn(section)) {
      return {
        kind: "blocked",
        reason: `the "${named}" profile signs in another way, such as with a token, and signing in under its name would replace that`,
      };
    }
    const host = options.host ?? section?.host;
    if (section?.host && host && workspaceOf(section.host) !== workspaceOf(host)) {
      return { kind: "blocked", reason: `the "${named}" profile is for a different workspace` };
    }
    if (!host) return { kind: "needs_host", profile: named };
    if (!isSafeHost(host)) return { kind: "blocked", reason: "its workspace URL isn't a plain https:// address" };
    return { kind: "ready", host, profile: named, reuses: section !== undefined };
  }
  if (!options.host) return { kind: "needs_host" };
  const workspace = workspaceOf(options.host);
  const existing = [...sections]
    .filter(([name, section]) => isBrowserSignIn(section) && workspaceOf(section.host) === workspace && isSafeProfileName(name))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b))[0];
  if (existing) return { kind: "ready", host: options.host, profile: existing, reuses: true };
  return { kind: "ready", host: options.host, profile: newProfileName(options.host, sections), reuses: false };
}

/**
 * Whether the CLI has updated the profile being signed in: after the change it signs in
 * through the browser for that workspace, and it is new, its settings changed, or the CLI
 * rewrote the file with no other profile changed (it writes the `.bak` copy each time it
 * saves a sign-in, whichever profile that is). Another edit to the file, or a sign-in to
 * another profile, is not one.
 */
export function profileUpdated(options: {
  before: ConfigSections;
  after: ConfigSections;
  profile: string;
  host: string;
  backupChanged: boolean;
}): boolean {
  const { before, after, profile } = options;
  const was = before.get(profile);
  const now = after.get(profile);
  if (!now || !isBrowserSignIn(now) || workspaceOf(now.host) !== workspaceOf(options.host)) return false;
  if (!was || text(was) !== text(now)) return true;
  if (!options.backupChanged) return false;
  const others = (sections: ConfigSections) =>
    JSON.stringify([...sections].filter(([name]) => name !== profile).map(([name, section]) => [name, text(section)]).sort());
  return others(before) === others(after);
}

/**
 * A profile other than `profile` that a sign-in just saved for the same workspace: new, or
 * its settings changed, and signing in through the browser. For a sign-in in another
 * terminal under the user's own name. Undefined when there is none.
 */
export function otherProfileSignedIn(options: {
  before: ConfigSections;
  after: ConfigSections;
  profile: string;
  host: string;
}): string | undefined {
  const workspace = workspaceOf(options.host);
  for (const [name, now] of options.after) {
    if (name === options.profile || !isBrowserSignIn(now) || workspaceOf(now.host) !== workspace) continue;
    const was = options.before.get(name);
    if (!was || text(was) !== text(now)) return name;
  }
  return undefined;
}

function text(section: ConfigSection): string {
  return JSON.stringify(Object.entries(section).sort(([a], [b]) => a.localeCompare(b)));
}
