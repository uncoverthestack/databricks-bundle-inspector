import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  BundleProgressTracker,
  checkOwners,
  gitHead,
  progressFindings,
  type CheckObservation,
  type ProgressFinding,
  type ProgressStorage,
  type ProgressState,
} from "../../../telemetry/bundleProgress.js";
import { validateProperties } from "../../../telemetry/schema.js";
import type { InspectorIssue } from "../../../bundle/issues.js";

const ROOT = "/Users/someone/work/sales_etl";
const MAIN = "ext 0.3.2\ncli 0.299.0\nref: refs/heads/main";
const FEATURE = "ext 0.3.2\ncli 0.299.0\nref: refs/heads/feature";

function memoryStorage(): ProgressStorage & { saved: ProgressState | undefined } {
  const storage = {
    saved: undefined as ProgressState | undefined,
    get: () => storage.saved,
    set: (state: ProgressState | undefined) => {
      storage.saved = state;
    },
  };
  return storage;
}

function finding(name: string, owner = "resources.jobs.nightly"): ProgressFinding {
  return { fingerprint: `missing-file:${name}`, owner };
}

function check(
  findings: ProgressFinding[],
  options: { conditions?: string; owners?: string[] } = {},
): CheckObservation {
  return {
    complete: true,
    conditions: options.conditions ?? MAIN,
    findings,
    owners: new Set(options.owners ?? ["resources.jobs.nightly", "resources.jobs.weekly"]),
  };
}

describe("BundleProgressTracker", () => {
  let now: number;
  let storage: ReturnType<typeof memoryStorage>;
  let tracker: BundleProgressTracker;
  const day = (date: number, hour = 10) => {
    now = new Date(2026, 9, date, hour).getTime();
  };

  beforeEach(() => {
    day(20);
    storage = memoryStorage();
    tracker = new BundleProgressTracker(storage, { now: () => now });
  });

  it("reports a resolved finding in the same bundle the next day", () => {
    expect(tracker.observe(ROOT, check([finding("a"), finding("b")]))).toBeUndefined();
    day(20, 11);
    expect(tracker.observe(ROOT, check([finding("b")]))).toBeUndefined();
    day(21);
    expect(tracker.rollOverDay()).toEqual({ comparison: "compared", resolved: "1", new: "0" });
  });

  it("says a first check could not be compared, rather than reporting zero", () => {
    tracker.observe(ROOT, check([finding("a")]));
    day(21);
    expect(tracker.rollOverDay()).toEqual({ comparison: "not_comparable" });
  });

  it("reports a check with no change as compared with nothing resolved", () => {
    tracker.observe(ROOT, check([finding("a")]));
    day(21);
    tracker.rollOverDay();
    tracker.observe(ROOT, check([finding("a")]));
    day(22);
    expect(tracker.rollOverDay()).toEqual({ comparison: "compared", resolved: "0", new: "0" });
  });

  it("counts the change over the day, not every save", () => {
    tracker.observe(ROOT, check([finding("a"), finding("b")]));
    tracker.observe(ROOT, check([finding("b")]));
    tracker.observe(ROOT, check([finding("a"), finding("b")]));
    tracker.observe(ROOT, check([finding("b")]));
    day(21);
    expect(tracker.rollOverDay()).toEqual({ comparison: "compared", resolved: "1", new: "0" });
  });

  it("counts a fix made between yesterday's last check and today's first", () => {
    tracker.observe(ROOT, check([finding("a"), finding("b")]));
    day(21);
    expect(tracker.observe(ROOT, check([finding("b")]))).toEqual({ comparison: "not_comparable" });
    day(22);
    expect(tracker.rollOverDay()).toEqual({ comparison: "compared", resolved: "1", new: "0" });
  });

  it("reports new findings alongside resolved ones", () => {
    tracker.observe(ROOT, check([finding("a")]));
    tracker.observe(ROOT, check([finding("b"), finding("c")]));
    day(21);
    expect(tracker.rollOverDay()).toEqual({ comparison: "compared", resolved: "1", new: "2-5" });
  });

  it("does not count a branch switch as fixes", () => {
    tracker.observe(ROOT, check([finding("a"), finding("b")]));
    tracker.observe(ROOT, check([], { conditions: FEATURE }));
    day(21);
    expect(tracker.rollOverDay()).toEqual({ comparison: "not_comparable" });
  });

  it.each([
    ["extension", "ext 0.3.3\ncli 0.299.0\nref: refs/heads/main"],
    ["CLI", "ext 0.3.2\ncli 0.300.0\nref: refs/heads/main"],
  ])("does not compare checks across %s versions", (_name, conditions) => {
    tracker.observe(ROOT, check([finding("a")]));
    tracker.observe(ROOT, check([], { conditions }));
    day(21);
    expect(tracker.rollOverDay()).toEqual({ comparison: "not_comparable" });
  });

  it("keeps fixes made before the conditions changed the same day", () => {
    tracker.observe(ROOT, check([finding("a"), finding("b")]));
    tracker.observe(ROOT, check([finding("b")]));
    tracker.observe(ROOT, check([], { conditions: FEATURE }));
    day(21);
    expect(tracker.rollOverDay()).toEqual({ comparison: "compared", resolved: "1", new: "0" });
  });

  it("does not count a finding gone with its job as resolved", () => {
    tracker.observe(ROOT, check([finding("a"), finding("b", "resources.jobs.weekly")]));
    tracker.observe(ROOT, check([finding("a")], { owners: ["resources.jobs.nightly"] }));
    day(21);
    expect(tracker.rollOverDay()).toEqual({ comparison: "compared", resolved: "0", new: "0" });
  });

  it("counts a bundle-wide finding as resolved when it is gone", () => {
    tracker.observe(ROOT, check([{ fingerprint: "include:matches-nothing:resource/*.yml" }]));
    tracker.observe(ROOT, check([]));
    day(21);
    expect(tracker.rollOverDay()).toEqual({ comparison: "compared", resolved: "1", new: "0" });
  });

  it("keeps the last complete check when a check fails, so a failure never looks like zero problems", () => {
    tracker.observe(ROOT, check([finding("a"), finding("b")]));
    tracker.observe(ROOT, { complete: false });
    tracker.observe(ROOT, check([finding("a"), finding("b")]));
    day(21);
    expect(tracker.rollOverDay()).toEqual({ comparison: "compared", resolved: "0", new: "0" });
  });

  it("reports a day of failed checks only as incomplete", () => {
    tracker.observe(ROOT, { complete: false });
    day(21);
    expect(tracker.rollOverDay()).toEqual({ comparison: "check_incomplete" });
  });

  it("sends nothing for a day without checks", () => {
    tracker.observe(ROOT, check([finding("a")]));
    day(21);
    tracker.rollOverDay();
    day(25);
    expect(tracker.rollOverDay()).toBeUndefined();
  });

  it("does not report a day twice when the clock goes back across midnight", () => {
    day(21, 0);
    tracker.observe(ROOT, check([finding("a"), finding("b")]));
    tracker.observe(ROOT, check([finding("b")]));
    now = new Date(2026, 9, 20, 23, 30).getTime();
    expect(tracker.observe(ROOT, check([finding("b")]))).toBeUndefined();
    day(21, 1);
    expect(tracker.observe(ROOT, check([finding("b")]))).toBeUndefined();
    day(22);
    expect(tracker.rollOverDay()).toEqual({ comparison: "compared", resolved: "1", new: "0" });
  });

  it("recovers from a clock that was set far ahead and then corrected", () => {
    now = new Date(2099, 0, 1, 10).getTime();
    tracker.observe(ROOT, check([finding("a")]));
    day(20, 12);
    tracker.observe(ROOT, check([]));
    day(21);
    expect(tracker.rollOverDay()).toEqual({ comparison: "compared", resolved: "1", new: "0" });
  });

  it("rolls over between days whose dates sort differently as text (9th to 10th)", () => {
    day(9);
    tracker.observe(ROOT, check([finding("a")]));
    tracker.observe(ROOT, check([]));
    day(10);
    expect(tracker.rollOverDay()).toEqual({ comparison: "compared", resolved: "1", new: "0" });
  });

  it("adds up bundles into one event", () => {
    const other = "/Users/someone/work/marketing";
    tracker.observe(ROOT, check([finding("a")]));
    tracker.observe(other, check([finding("x"), finding("y")]));
    day(21);
    tracker.rollOverDay();
    tracker.observe(ROOT, check([]));
    tracker.observe(other, check([]));
    day(22);
    expect(tracker.rollOverDay()).toEqual({ comparison: "compared", resolved: "2-5", new: "0" });
  });

  it("does not compare a bundle with too many findings to keep", () => {
    const many = Array.from({ length: 201 }, (_, index) => finding(String(index)));
    tracker.observe(ROOT, check(many));
    tracker.observe(ROOT, check([]));
    day(21);
    expect(tracker.rollOverDay()).toEqual({ comparison: "not_comparable" });
  });

  it("stores no paths, names, branches or finding text", () => {
    tracker.observe(ROOT, check([finding("src/etl.py")]));
    const stored = JSON.stringify(storage.saved);
    for (const text of ["someone", "sales_etl", "etl.py", "nightly", "main", "0.299.0"]) {
      expect(stored).not.toContain(text);
    }
  });

  it("hashes with a salt of its own, so the same bundle looks different on another install", () => {
    tracker.observe(ROOT, check([finding("a")]));
    const otherStorage = memoryStorage();
    new BundleProgressTracker(otherStorage, { now: () => now }).observe(ROOT, check([finding("a")]));
    expect(Object.keys(otherStorage.saved!.bundles)).not.toEqual(Object.keys(storage.saved!.bundles));
  });

  it("deletes what it kept when cleared", () => {
    tracker.observe(ROOT, check([finding("a")]));
    tracker.clear();
    expect(storage.saved).toBeUndefined();
    day(21);
    expect(tracker.rollOverDay()).toBeUndefined();
  });

  it("forgets bundles not checked for 90 days", () => {
    tracker.observe(ROOT, check([finding("a")]));
    now += 91 * 24 * 60 * 60 * 1000;
    tracker.observe("/elsewhere", check([]));
    expect(Object.keys(storage.saved!.bundles)).toHaveLength(1);
  });

  it("starts over when the stored state is unreadable", () => {
    storage.saved = { nonsense: true } as unknown as ProgressState;
    expect(tracker.observe(ROOT, check([finding("a")]))).toBeUndefined();
    day(21);
    expect(tracker.rollOverDay()).toEqual({ comparison: "not_comparable" });
  });

  it("sends only values the schema allows", () => {
    tracker.observe(ROOT, check([finding("a")]));
    tracker.observe(ROOT, check([]));
    day(21);
    const event = tracker.rollOverDay()!;
    expect(validateProperties("bundle_progress", event)).toEqual(event);
  });
});

describe("progressFindings", () => {
  /** An issue with `overrides` applied; a key set to undefined is left out. */
  const issue = (overrides: { [K in keyof InspectorIssue]?: InspectorIssue[K] | undefined }): InspectorIssue => {
    const merged: Record<string, unknown> = {
      id: "missing-file:resources.jobs.nightly.tasks.load:notebook_task.notebook_path:src/load.py",
      severity: "error",
      kind: "missing_file",
      title: "File not found",
      taskId: "resources.jobs.nightly.tasks.load",
      resourceId: "resources.jobs.nightly",
      file: "/bundle/resources/nightly.yml",
      line: 12,
      ...overrides,
    };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    return merged as unknown as InspectorIssue;
  };
  const ownerOf = (overrides: Parameters<typeof issue>[0]) => progressFindings([issue(overrides)])[0]?.owner;

  it("keeps errors and warnings, not notes", () => {
    const findings = progressFindings([
      issue({}),
      issue({ id: "w", severity: "warning" }),
      issue({ id: "n", severity: "info", kind: "path_not_checked" }),
    ]);
    expect(findings.map((f) => f.fingerprint)).toEqual([issue({}).id, "w"]);
  });

  it("ignores the line, so editing above a finding keeps it the same finding", () => {
    expect(progressFindings([issue({ line: 12 })])).toEqual(progressFindings([issue({ line: 40 })]));
  });

  it("matches CLI findings by what they say, not by their place in the CLI output", () => {
    const cli = (index: number, title: string) =>
      issue({ id: `validation:0:${index}`, kind: "cli_diagnostic", title, taskId: undefined });
    const before = progressFindings([cli(0, "first"), cli(1, "second")]);
    const after = progressFindings([cli(0, "second")]);
    expect(after[0]?.fingerprint).toBe(before[1]?.fingerprint);
  });

  it("belongs to its task first, then its resource, then its file", () => {
    expect(ownerOf({})).toBe("resources.jobs.nightly.tasks.load");
    expect(ownerOf({ taskId: undefined })).toBe("resources.jobs.nightly");
    expect(ownerOf({ taskId: undefined, resourceId: undefined })).toBe("/bundle/resources/nightly.yml");
    expect(ownerOf({ taskId: undefined, resourceId: undefined, file: undefined })).toBeUndefined();
  });

  it("collects owners from the graph, the loaded files and the findings' files", () => {
    expect(
      [...checkOwners(["resources.jobs.nightly"], ["/bundle/databricks.yml"], [issue({})])].sort(),
    ).toEqual(["/bundle/databricks.yml", "/bundle/resources/nightly.yml", "resources.jobs.nightly"]);
  });
});

describe("gitHead", () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), "bundle-progress-"));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("reads the branch of the repository above the bundle", async () => {
    await mkdir(path.join(folder, ".git"));
    await writeFile(path.join(folder, ".git", "HEAD"), "ref: refs/heads/main\n");
    await mkdir(path.join(folder, "bundles", "etl"), { recursive: true });
    expect(gitHead(path.join(folder, "bundles", "etl"))).toBe("ref: refs/heads/main");
  });

  it("follows a worktree's .git file", async () => {
    const gitDir = path.join(folder, "main-repo", ".git", "worktrees", "wt");
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
    await mkdir(path.join(folder, "wt"));
    await writeFile(path.join(folder, "wt", ".git"), `gitdir: ${gitDir}\n`);
    expect(gitHead(path.join(folder, "wt"))).toBe("ref: refs/heads/feature");
  });

  it("reads a detached HEAD as its commit", async () => {
    await mkdir(path.join(folder, ".git"));
    await writeFile(path.join(folder, ".git", "HEAD"), "fd220feda89ea653a3b8190d3639199168cd09a5\n");
    expect(gitHead(folder)).toBe("fd220feda89ea653a3b8190d3639199168cd09a5");
  });

  it.each([
    ["a .git file pointing nowhere", async (dir: string) => writeFile(path.join(dir, ".git"), "gitdir: ./missing\n")],
    ["a .git file without gitdir", async (dir: string) => writeFile(path.join(dir, ".git"), "nonsense\n")],
    ["a .git folder without HEAD", async (dir: string) => mkdir(path.join(dir, ".git"))],
  ])("does not borrow the branch of the repository around %s", async (_name, makeBroken) => {
    await mkdir(path.join(folder, ".git"));
    await writeFile(path.join(folder, ".git", "HEAD"), "ref: refs/heads/main\n");
    const inner = path.join(folder, "inner");
    await mkdir(inner);
    await makeBroken(inner);
    expect(gitHead(inner)).toBe("");
  });

  it("is empty outside a repository", () => {
    // tmpdir() is not in a repository on the machines the tests run on.
    expect(gitHead(folder)).toBe("");
  });
});
