import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { InspectorIssue } from "../bundle/issues.js";
import { countBucket } from "./events.js";
import type { TelemetryProperties } from "./schema.js";

/**
 * Whether one install's findings get resolved, compared between complete checks of the
 * same bundle under the same conditions. Everything that could name a project (bundle
 * paths, findings, branches) stays on this machine, salted and hashed. Only one event a
 * day leaves it: whether a comparison was possible, and how many findings were resolved
 * and how many were new, as ranges.
 */

/** One error or warning of a complete check, as the comparison needs it. */
export interface ProgressFinding {
  /** What makes it the same finding in the next check: kind, resource, YAML path and value, never the line. */
  fingerprint: string;
  /** The task, resource or file it belongs to. Undefined for a bundle-wide finding. */
  owner?: string;
}

export type CheckObservation =
  | { complete: false }
  | {
      complete: true;
      /** Branch, extension and CLI version: checks under different ones are not compared. */
      conditions: string;
      findings: readonly ProgressFinding[];
      /** The tasks, resources and files the check saw, so a finding gone with its source is not counted as resolved. */
      owners: ReadonlySet<string>;
    };

export interface ProgressStorage {
  get(): unknown;
  set(state: ProgressState | undefined): PromiseLike<void> | void;
}

export interface ProgressState {
  salt: string;
  bundles: Record<string, BundleRecord>;
  day: DayTotals;
}

interface BundleRecord {
  conditions: string;
  /** Findings when today's comparison began: the last complete check before today, or today's first. */
  start: string[];
  /** Findings of the last complete check. Each is `fingerprint` or `fingerprint:owner`, hashed. */
  latest: string[];
  /** Resolved and new between `start` and `latest`, once a comparison was made. */
  resolved: number;
  added: number;
  compared: boolean;
  seenAt: number;
}

interface DayTotals {
  day: string;
  /** From comparisons ended today by a change of conditions. Open ones are in the bundle records. */
  resolved: number;
  added: number;
  compared: boolean;
  notComparable: boolean;
  incomplete: boolean;
}

const MAX_BUNDLES = 20;
const MAX_FINDINGS = 200;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const HASH_LENGTH = 12;

/** The local date as YYYY-MM-DD, so later days sort after earlier ones. */
function localDay(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function emptyDay(day: string): DayTotals {
  return { day, resolved: 0, added: 0, compared: false, notComparable: false, incomplete: false };
}

function isState(value: unknown): value is ProgressState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<ProgressState>;
  return (
    typeof state.salt === "string" &&
    typeof state.bundles === "object" &&
    state.bundles !== null &&
    typeof state.day === "object" &&
    state.day !== null
  );
}

export class BundleProgressTracker {
  private readonly now: () => number;

  constructor(
    private readonly storage: ProgressStorage,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Records one check of a bundle. Returns the properties of the previous day's
   * `bundle_progress` event when this is the first check of a new day.
   */
  observe(bundleRoot: string, observation: CheckObservation): TelemetryProperties | undefined {
    const state = this.load();
    const event = this.rollOver(state);
    if (!observation.complete) {
      state.day.incomplete = true;
      this.save(state);
      return event;
    }

    const key = this.hash(state, bundleRoot);
    const record = state.bundles[key];
    if (observation.findings.length > MAX_FINDINGS) {
      // Too many to keep. Starting over next time is safer than comparing part of them.
      if (record) this.close(state, record);
      delete state.bundles[key];
      state.day.notComparable = true;
      this.save(state);
      return event;
    }

    const latest = [
      ...new Set(
        observation.findings.map((finding) =>
          finding.owner === undefined
            ? this.hash(state, finding.fingerprint)
            : `${this.hash(state, finding.fingerprint)}:${this.hash(state, finding.owner)}`,
        ),
      ),
    ];
    const conditions = this.hash(state, observation.conditions);
    if (!record || record.conditions !== conditions) {
      if (record) this.close(state, record);
      state.bundles[key] = {
        conditions,
        start: latest,
        latest,
        resolved: 0,
        added: 0,
        compared: false,
        seenAt: this.now(),
      };
      state.day.notComparable = true;
      this.save(state);
      return event;
    }

    const owners = new Set([...observation.owners].map((owner) => this.hash(state, owner)));
    const fingerprintOf = (entry: string) => entry.split(":")[0];
    const latestFingerprints = new Set(latest.map(fingerprintOf));
    const startFingerprints = new Set(record.start.map(fingerprintOf));
    record.resolved = record.start.filter((entry) => {
      const [fingerprint, owner] = entry.split(":");
      // Gone with its task, resource or file is not resolved.
      return !latestFingerprints.has(fingerprint) && (owner === undefined || owners.has(owner));
    }).length;
    record.added = [...latestFingerprints].filter((fingerprint) => !startFingerprints.has(fingerprint)).length;
    record.latest = latest;
    record.compared = true;
    record.seenAt = this.now();
    this.save(state);
    return event;
  }

  /** Sends the previous day's event, if any, without a check, e.g. when the extension starts. */
  rollOverDay(): TelemetryProperties | undefined {
    const stored = this.storage.get();
    if (!isState(stored)) return undefined;
    const state = this.load();
    const event = this.rollOver(state);
    if (event) this.save(state);
    return event;
  }

  /** Deletes everything kept on this machine, for when telemetry is turned off. */
  clear(): void {
    if (this.storage.get() === undefined) return;
    this.write(undefined);
  }

  private load(): ProgressState {
    const stored = this.storage.get();
    if (isState(stored)) return structuredClone(stored);
    return { salt: randomBytes(16).toString("hex"), bundles: {}, day: emptyDay(localDay(this.now())) };
  }

  private rollOver(state: ProgressState): TelemetryProperties | undefined {
    const today = localDay(this.now());
    // A clock set back (a new time zone, a corrected clock) stays in the day already
    // counted, so one day is never reported twice. A day further ahead than any time zone
    // reaches came from a wrong clock: drop it rather than wait for that date.
    if (today <= state.day.day) {
      if (localDay(this.now() + 2 * 24 * 60 * 60 * 1000) < state.day.day) state.day = emptyDay(today);
      return undefined;
    }
    const records = Object.values(state.bundles);
    const compared = state.day.compared || records.some((record) => record.compared);
    let event: TelemetryProperties | undefined;
    if (compared) {
      let resolved = state.day.resolved;
      let added = state.day.added;
      for (const record of records) {
        if (!record.compared) continue;
        resolved += record.resolved;
        added += record.added;
      }
      event = { comparison: "compared", resolved: countBucket(resolved), new: countBucket(added) };
    } else if (state.day.notComparable) {
      event = { comparison: "not_comparable" };
    } else if (state.day.incomplete) {
      event = { comparison: "check_incomplete" };
    }
    for (const record of records) {
      record.start = record.latest;
      record.resolved = 0;
      record.added = 0;
      record.compared = false;
    }
    state.day = emptyDay(today);
    return event;
  }

  /** Ends a bundle's comparison early, keeping what it found for today's event. */
  private close(state: ProgressState, record: BundleRecord): void {
    if (!record.compared) return;
    state.day.resolved += record.resolved;
    state.day.added += record.added;
    state.day.compared = true;
  }

  private save(state: ProgressState): void {
    const cutoff = this.now() - MAX_AGE_MS;
    const kept = Object.entries(state.bundles)
      .filter(([, record]) => record.seenAt >= cutoff)
      .sort(([, a], [, b]) => b.seenAt - a.seenAt)
      .slice(0, MAX_BUNDLES);
    state.bundles = Object.fromEntries(kept);
    this.write(state);
  }

  private write(state: ProgressState | undefined): void {
    try {
      void Promise.resolve(this.storage.set(state)).catch(() => {});
    } catch {
      // Storage failures must never affect the extension.
    }
  }

  private hash(state: ProgressState, value: string): string {
    return createHash("sha256").update(`${state.salt}:${value}`).digest("hex").slice(0, HASH_LENGTH);
  }
}

/**
 * The errors and warnings to compare. A finding from `bundle validate` is numbered by its
 * place in the CLI's output, so it is matched by what it says instead.
 */
export function progressFindings(issues: readonly InspectorIssue[]): ProgressFinding[] {
  return issues
    .filter((issue) => issue.severity === "error" || issue.severity === "warning")
    .map((issue) => {
      const fingerprint = issue.id.startsWith("validation:")
        ? ["validation", issue.kind, issue.file ?? "", issue.yamlPath ?? "", issue.title, issue.detail ?? ""].join("\n")
        : issue.id;
      const owner = issue.taskId ?? issue.resourceId ?? issue.file;
      return owner === undefined ? { fingerprint } : { fingerprint, owner };
    });
}

/** What a check saw: its graph's tasks and resources, the files it loaded, and the files its findings are in. */
export function checkOwners(
  nodeIds: Iterable<string>,
  loadedFiles: Iterable<string>,
  issues: readonly InspectorIssue[],
): Set<string> {
  const owners = new Set([...nodeIds, ...loadedFiles]);
  for (const issue of issues) if (issue.file) owners.add(issue.file);
  return owners;
}

/**
 * The checked-out branch (or commit, when detached) of the repository holding a bundle,
 * as `.git/HEAD` says it, or "" outside a repository. Read from disk, so it needs no git.
 */
export function gitHead(bundleRoot: string): string {
  let folder = path.resolve(bundleRoot);
  for (;;) {
    const dotGit = path.join(folder, ".git");
    let isFile: boolean | undefined;
    try {
      isFile = statSync(dotGit).isFile();
    } catch {
      // Not here: look in the parent folder.
    }
    if (isFile !== undefined) {
      // This is the repository, even if it can't be read: never fall back to one around it.
      try {
        let gitDir = dotGit;
        // A worktree or submodule has a `.git` file pointing at its git folder.
        if (isFile) {
          const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
          if (!pointer) return "";
          gitDir = path.resolve(folder, pointer.trim());
        }
        return readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      } catch {
        return "";
      }
    }
    const parent = path.dirname(folder);
    if (parent === folder) return "";
    folder = parent;
  }
}
