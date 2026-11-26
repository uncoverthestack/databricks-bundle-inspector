import { locator, type SourceFile } from "./jobStructure.js";
import type { YamlLocation } from "./sourceLocations.js";

/**
 * Clusters on a Databricks Runtime near or past its end of support (issue 485).
 *
 * `bundle validate` and `bundle deploy` don't read `spark_version`. Past end of support a
 * cluster still starts (live, CLI v1.27.0, 2026-11-23: 12.2 LTS and 13.3 LTS job clusters ran),
 * but Databricks no longer fixes the version, security included. Past end of life it is removed
 * and workloads on it fail; Databricks says 10.4 LTS and earlier have reached end of life, and
 * has announced no end-of-life date for any later version.
 *
 * The dates come from the Databricks docs, not from an API: `clusters/spark-versions` has no
 * dates, and a version it still lists may already be past end of support (13.3 LTS was).
 */

/** When the table below was read from the docs. */
export const RUNTIME_DATES_CHECKED = "2026-11-24";

/** The docs pages the table comes from. */
export const RUNTIME_DATES_SOURCES = [
  "https://docs.databricks.com/aws/en/release-notes/runtime/",
  "https://docs.databricks.com/aws/en/release-notes/runtime/eos",
] as const;

export interface RuntimeRelease {
  lts: boolean;
  /** End of support, as YYYY-MM-DD. Not set while Databricks hasn't given one (19). */
  endOfSupport?: string;
  /** End of life, as YYYY-MM-DD, once Databricks announces it. None is announced for 10.5 and later. */
  endOfLife?: string;
}

/** By version as Databricks writes it: "18" is 18 LTS (`18.x-scala2.13`), "15.4" is 15.4 LTS (`15.4.x-...`). */
export const RUNTIME_RELEASES: Readonly<Record<string, RuntimeRelease>> = {
  "19": { lts: false },
  "18": { lts: true, endOfSupport: "2029-06-10" },
  "18.2": { lts: false, endOfSupport: "2026-11-05" },
  "18.1": { lts: false, endOfSupport: "2026-09-11" },
  "18.0": { lts: false, endOfSupport: "2026-07-15" },
  "17.3": { lts: true, endOfSupport: "2028-10-22" },
  "17.2": { lts: false, endOfSupport: "2026-03-16" },
  "17.1": { lts: false, endOfSupport: "2026-02-01" },
  "17.0": { lts: false, endOfSupport: "2025-12-23" },
  "16.4": { lts: true, endOfSupport: "2028-05-09" },
  "16.3": { lts: false, endOfSupport: "2025-09-30" },
  "16.2": { lts: false, endOfSupport: "2025-08-05" },
  "16.1": { lts: false, endOfSupport: "2025-06-20" },
  "16.0": { lts: false, endOfSupport: "2025-05-11" },
  "15.4": { lts: true, endOfSupport: "2027-08-19" },
  "15.3": { lts: false, endOfSupport: "2025-01-07" },
  "15.2": { lts: false, endOfSupport: "2025-01-07" },
  "15.1": { lts: false, endOfSupport: "2024-10-30" },
  "15.0": { lts: false, endOfSupport: "2024-05-31" },
  "14.3": { lts: true, endOfSupport: "2027-02-01" },
  "14.2": { lts: false, endOfSupport: "2024-11-05" },
  "14.1": { lts: false, endOfSupport: "2025-02-12" },
  "14.0": { lts: false, endOfSupport: "2024-03-11" },
  "13.3": { lts: true, endOfSupport: "2026-08-22" },
  "13.2": { lts: false, endOfSupport: "2024-01-06" },
  "13.1": { lts: false, endOfSupport: "2023-12-01" },
  "13.0": { lts: false, endOfSupport: "2023-10-14" },
  "12.2": { lts: true, endOfSupport: "2026-03-01" },
  "12.1": { lts: false, endOfSupport: "2023-07-18" },
  "12.0": { lts: false, endOfSupport: "2023-06-15" },
  "11.3": { lts: true, endOfSupport: "2025-10-19" },
  "11.2": { lts: false, endOfSupport: "2023-03-07" },
  "11.1": { lts: false, endOfSupport: "2023-01-27" },
  "11.0": { lts: false, endOfSupport: "2022-12-16" },
  "10.5": { lts: false, endOfSupport: "2022-11-04" },
};

/** A hint starts this many days before end of support: a month, so a far-off date is not shown. */
export const HINT_DAYS_BEFORE = 30;

const DAY = 24 * 60 * 60 * 1000;

/** The version a `spark_version` names: `15.4.x-photon-scala2.12` is "15.4", `18.x-scala2.13` is "18". */
export function runtimeVersionOf(sparkVersion: string): string | undefined {
  const match = /^(\d+)\.(?:(\d+)\.)?x(?:-|$)/.exec(sparkVersion.trim());
  if (!match) return undefined;
  return match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`;
}

/** "15.4 LTS", "18 LTS", "18.2", or the bare version when it isn't in the table. */
export function runtimeName(version: string): string {
  return RUNTIME_RELEASES[version]?.lts ? `${version} LTS` : version;
}

/** Databricks: "Databricks Runtime 10.4 LTS and earlier have reached end-of-life." */
function pastDocumentedEndOfLife(version: string): boolean {
  const [major = NaN, minor = 0] = version.split(".").map(Number);
  return major < 10 || (major === 10 && minor <= 4);
}

/** The newest LTS in the table, the one to move to. */
export function newestLts(): { version: string; endOfSupport: string } {
  const lts = Object.entries(RUNTIME_RELEASES)
    .filter(([, release]) => release.lts && release.endOfSupport)
    .sort(([, a], [, b]) => (a.endOfSupport! < b.endOfSupport! ? 1 : -1));
  const [version, release] = lts[0]!;
  return { version, endOfSupport: release.endOfSupport! };
}

export type RuntimeSupport =
  | { state: "end_of_life"; version: string; date?: string }
  | { state: "past_end_of_support"; version: string; date: string }
  | { state: "ends_soon"; version: string; date: string }
  | { state: "supported" | "unknown"; version: string };

/** Where a version stands on `today` (YYYY-MM-DD). A version not in the table is "unknown": never guessed. */
export function runtimeSupport(version: string, today: string): RuntimeSupport {
  const release = RUNTIME_RELEASES[version];
  if (release?.endOfLife && release.endOfLife <= today) return { state: "end_of_life", version, date: release.endOfLife };
  if (!release && pastDocumentedEndOfLife(version)) return { state: "end_of_life", version };
  if (!release?.endOfSupport) return { state: release ? "supported" : "unknown", version };
  if (release.endOfSupport <= today) return { state: "past_end_of_support", version, date: release.endOfSupport };
  const daysLeft = (Date.parse(release.endOfSupport) - Date.parse(today)) / DAY;
  if (daysLeft <= HINT_DAYS_BEFORE) return { state: "ends_soon", version, date: release.endOfSupport };
  return { state: "supported", version };
}

/**
 * Today as YYYY-MM-DD. The test runners set DATABRICKS_BUNDLE_INSPECTOR_TODAY to a fixed day,
 * so fixtures give the same findings every day; a value that isn't a date is ignored.
 */
export function todayForChecks(): string {
  const fixed = typeof process !== "undefined" ? process.env?.DATABRICKS_BUNDLE_INSPECTOR_TODAY : undefined;
  return fixed && /^\d{4}-\d{2}-\d{2}$/.test(fixed) ? fixed : new Date().toISOString().slice(0, 10);
}

export interface RuntimeSupportFinding {
  severity: "warning" | "info";
  /** `resources.clusters.x`, or `resources.jobs.x` with a task or job cluster. */
  resourceId: string;
  taskKey?: string;
  /** The job cluster's key, or the task's, that tells two findings in a job apart. */
  subject: string;
  title: string;
  fixHint: string;
  location?: YamlLocation;
}

export interface RuntimeSupportOptions {
  /** Today as YYYY-MM-DD; the unit tests pass a fixed day. */
  today?: string;
  activeTarget?: string;
  /** A value with `${...}` in it as the CLI would read it, or undefined when that can't be told offline. */
  resolve?: (value: string, target: string | undefined) => string | undefined;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function wording(support: RuntimeSupport): Pick<RuntimeSupportFinding, "severity" | "title" | "fixHint"> | undefined {
  const name = `Databricks Runtime ${runtimeName(support.version)}`;
  const next = newestLts();
  const moveTo = `The newest LTS is ${runtimeName(next.version)}, supported until ${next.endOfSupport}.`;
  switch (support.state) {
    case "end_of_life":
      return {
        severity: "warning",
        title: `${name} may be past end of life. Runs on it may fail to start.`,
        fixHint: `Databricks removes a version at end of life, and workloads on it fail. It lists 10.4 LTS and earlier as past end of life. ${moveTo}`,
      };
    case "past_end_of_support":
      return {
        severity: "warning",
        title: `${name} may be past end of support and no longer gets security fixes.`,
        fixHint: `Support ended on ${support.date}. Clusters on it still start, but Databricks no longer fixes it. ${moveTo}`,
      };
    case "ends_soon":
      return {
        severity: "info",
        title: `${name} is supported until ${support.date}.`,
        fixHint: `After that date it gets no security fixes. ${moveTo}`,
      };
    default:
      return undefined;
  }
}

/** Where a value is written: the picked target's override first, then the resource's own. */
function firstLocation(
  files: SourceFile[],
  locate: Map<SourceFile, (path: (string | number)[]) => YamlLocation | undefined>,
  paths: (target: string | undefined) => Array<{ file: SourceFile; path: (string | number)[] }>,
  activeTarget: string | undefined,
): YamlLocation | undefined {
  for (const target of activeTarget ? [activeTarget, undefined] : [undefined]) {
    for (const { file, path } of paths(target)) {
      const found = locate.get(file)?.(path);
      if (found) return found;
    }
  }
  return undefined;
}

/** A resource's place in a file: `resources.<kind>.<key>`, or the same under `targets.<target>`. */
function resourceRoot(doc: unknown, kind: string, key: string, target: string | undefined) {
  const root = target ? record(record(record(doc).targets)[target]) : record(doc);
  const resource = record(record(root.resources)[kind])[key];
  const path = target ? ["targets", target, "resources", kind, key] : ["resources", kind, key];
  return resource === undefined ? undefined : { resource: record(resource), path };
}

/**
 * Every `spark_version` in the bundle as the CLI resolved it: all-purpose clusters, job clusters,
 * and a task's own `new_cluster` (also a for-each task's inner task). Pipelines use `channel`,
 * not `spark_version`, and `existing_cluster_id` doesn't say its version, so neither is checked.
 */
export function findRuntimeSupportProblems(
  resources: Record<string, unknown>,
  files: SourceFile[],
  options: RuntimeSupportOptions = {},
): RuntimeSupportFinding[] {
  const today = options.today ?? todayForChecks();
  const locate = new Map(files.map((file) => [file, locator(file)]));
  const findings: RuntimeSupportFinding[] = [];

  const judge = (
    raw: unknown,
    finding: Pick<RuntimeSupportFinding, "resourceId" | "subject" | "taskKey">,
    where: () => YamlLocation | undefined,
  ) => {
    if (typeof raw !== "string") return;
    const value = raw.includes("${") ? options.resolve?.(raw, options.activeTarget) : raw;
    if (!value || value.includes("${")) return;
    const version = runtimeVersionOf(value);
    if (!version) return;
    const words = wording(runtimeSupport(version, today));
    if (!words) return;
    const location = where();
    findings.push({ ...finding, ...words, ...(location ? { location } : {}) });
  };

  for (const [key, cluster] of Object.entries(record(resources.clusters))) {
    judge(record(cluster).spark_version, { resourceId: `resources.clusters.${key}`, subject: key }, () =>
      firstLocation(
        files,
        locate,
        (target) =>
          files.flatMap((file) => {
            const at = resourceRoot(file.doc, "clusters", key, target);
            return at ? [{ file, path: [...at.path, "spark_version"] }] : [];
          }),
        options.activeTarget,
      ),
    );
  }

  for (const [jobKey, job] of Object.entries(record(resources.jobs))) {
    const resourceId = `resources.jobs.${jobKey}`;
    // Where an entry of a job list (`job_clusters` or `tasks`) with this key writes a field.
    const inList = (listName: string, keyField: string, entryKey: string, field: (string | number)[]) => () =>
      firstLocation(
        files,
        locate,
        (target) =>
          files.flatMap((file) => {
            const at = resourceRoot(file.doc, "jobs", jobKey, target);
            if (!at) return [];
            const index = list(at.resource[listName]).findIndex((entry) => record(entry)[keyField] === entryKey);
            return index < 0 ? [] : [{ file, path: [...at.path, listName, index, ...field] }];
          }),
        options.activeTarget,
      );

    for (const jobCluster of list(record(job).job_clusters)) {
      const clusterKey = record(jobCluster).job_cluster_key;
      if (typeof clusterKey !== "string") continue;
      judge(
        record(record(jobCluster).new_cluster).spark_version,
        { resourceId, subject: `job_cluster:${clusterKey}` },
        inList("job_clusters", "job_cluster_key", clusterKey, ["new_cluster", "spark_version"]),
      );
    }
    for (const task of list(record(job).tasks)) {
      const taskKey = record(task).task_key;
      if (typeof taskKey !== "string") continue;
      judge(
        record(record(task).new_cluster).spark_version,
        { resourceId, taskKey, subject: `task:${taskKey}` },
        inList("tasks", "task_key", taskKey, ["new_cluster", "spark_version"]),
      );
      const inner = record(record(record(task).for_each_task).task);
      judge(
        record(inner.new_cluster).spark_version,
        { resourceId, taskKey, subject: `for_each:${taskKey}` },
        inList("tasks", "task_key", taskKey, ["for_each_task", "task", "new_cluster", "spark_version"]),
      );
    }
  }
  return findings;
}
