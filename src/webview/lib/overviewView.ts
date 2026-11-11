/**
 * What the bundle overview screen says about each box: its type in words, the short grey
 * note beside its name, which boxes light up together, and which groups start folded.
 * Kept apart from the component so each rule has a unit test.
 */
import type { BundleOverview, OverviewGroup, OverviewItem, OverviewLink } from "./bundleOverview.js";

/** Up to this many boxes, every line shows and no group is folded. Above it, lines show on demand. */
export const SMALL_BUNDLE_MAX_ITEMS = 15;

const KIND_WORDS: Record<string, string> = {
  job: "job",
  pipeline: "pipeline",
  warehouse: "SQL warehouse",
  cluster: "cluster",
  secret_scope: "secret scope",
};

const WORD_CASE: Record<string, string> = {
  sql: "SQL",
  mcp: "MCP",
  postgres: "Postgres",
  genie: "Genie",
};

/** `registered_models` → `registered model`, `postgres_branches` → `Postgres branch`. */
export function resourceGroupWords(resourceGroup: string): string {
  const singular = resourceGroup
    .replace(/ies$/, "y")
    .replace(/(ch|sh|x)es$/, "$1")
    .replace(/s$/, "");
  return singular
    .split("_")
    .map((word) => WORD_CASE[word] ?? word)
    .join(" ");
}

/** The box's type in words, such as `SQL warehouse` or `dashboard`. */
export function typeWords(item: OverviewItem): string {
  return KIND_WORDS[item.kind] ?? resourceGroupWords(item.resourceGroup ?? item.kind);
}

/** True when the name points outside this bundle, so only what the bundle says is known. */
export function namedOutside(item: OverviewItem): boolean {
  return item.source === "variable" || item.source === "fixed" || item.source === "workspace" || item.source === "missing";
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function allItems(overview: BundleOverview): OverviewItem[] {
  return overview.groups.flatMap((group) => group.items);
}

/** How many tasks, in how many jobs, use a box: `2 tasks`, `4 tasks in 2 jobs`. Empty when none do. */
export function usedByWords(overview: BundleOverview, itemId: string): string {
  const incoming = overview.links.filter((link) => link.to === itemId && link.taskIds.length > 0);
  const tasks = incoming.reduce((sum, link) => sum + link.taskIds.length, 0);
  if (tasks === 0) return "";
  return incoming.length > 1 ? `${count(tasks, "task")} in ${incoming.length} jobs` : count(tasks, "task");
}

/** The short grey note beside a box's name. */
export function itemNote(overview: BundleOverview, item: OverviewItem): string {
  // Every note starts with the type in words: there is no type code beside the name (issue 400).
  if (item.kind === "job" && item.source === "bundle") {
    return [typeWords(item), typeof item.taskCount === "number" ? count(item.taskCount, "task") : ""].filter(Boolean).join(" · ");
  }
  const labelOf = (id: string) => allItems(overview).find((entry) => entry.id === id)?.label ?? id;
  // Serverless or inherited compute isn't a cluster: Databricks calls it serverless compute.
  const parts: string[] = [item.source === "default" ? "compute" : typeWords(item)];
  switch (item.source) {
    case "variable":
      parts.push("from a variable");
      break;
    case "fixed":
      parts.push("written in");
      break;
    case "workspace":
      parts.push("not in this bundle");
      break;
    case "missing":
      parts.push("may not exist");
      break;
    case "job_cluster":
      parts.push(`defined in ${labelOf(item.definedIn ?? "")}`);
      break;
    default:
      break;
  }
  if (item.kind === "pipeline") {
    const runners = overview.links.filter((link) => link.to === item.id && link.kind === "runs");
    if (runners.length > 0) parts.push(`run by ${runners.map((link) => labelOf(link.from)).join(", ")}`);
    return parts.join(" · ");
  }
  const used = usedByWords(overview, item.id);
  if (used) parts.push(used);
  return parts.join(" · ");
}

/** The boxes joined to this one by a link, in either direction. */
export function linkedIds(overview: BundleOverview, itemId: string): Set<string> {
  const ids = new Set<string>();
  for (const link of overview.links) {
    if (link.from === itemId) ids.add(link.to);
    if (link.to === itemId) ids.add(link.from);
  }
  return ids;
}

/** The links that touch this box. */
export function linksOf(overview: BundleOverview, itemId: string): OverviewLink[] {
  return overview.links.filter((link) => link.from === itemId || link.to === itemId);
}

export function itemCount(overview: BundleOverview): number {
  return overview.groups.reduce((sum, group) => sum + group.items.length, 0);
}

/** A small bundle shows every line. A larger one shows lines only for the active box. */
export function showsAllLines(overview: BundleOverview): boolean {
  return itemCount(overview) <= SMALL_BUNDLE_MAX_ITEMS;
}

/** True when the inspector has no checks for any box in the group and no line touches one. */
export function isUnchecked(overview: BundleOverview, group: OverviewGroup): boolean {
  const linked = new Set(overview.links.flatMap((link) => [link.from, link.to]));
  return group.items.every((item) => !item.hasChecks && !linked.has(item.id));
}

/**
 * The groups that start as one line: unchecked groups, in a bundle too big to show
 * everything at once. A group with a problem on one of its boxes stays open.
 */
export function foldedGroupIds(overview: BundleOverview): Set<string> {
  if (showsAllLines(overview)) return new Set();
  return new Set(
    overview.groups
      .filter(
        (group) =>
          isUnchecked(overview, group) &&
          group.items.every((item) => item.problems.errors + item.problems.warnings === 0),
      )
      .map((group) => group.id),
  );
}

/** One line on where a box's name comes from, for its details. */
export function sourceSentence(item: OverviewItem): string {
  switch (item.source) {
    case "bundle":
      return "Defined in this bundle.";
    case "job_cluster":
      return "A cluster defined inside the job.";
    case "variable":
      return `Named by a variable${item.expression ? `: ${item.expression}` : ""}.`;
    case "fixed":
      return "Written in as an ID or name. The bundle does not define it.";
    case "default":
      return "No compute is set, so these tasks run on serverless or inherited compute.";
    case "workspace":
      return "The bundle does not define it.";
    case "missing":
      return `The bundle has no resource for ${item.expression ?? "this reference"}. It may not exist.`;
    default:
      return "";
  }
}

function problemRank(item: OverviewItem): number {
  if (item.problems.errors > 0) return 0;
  if (item.problems.warnings > 0) return 1;
  return 2;
}

/** A group's boxes with errors first, then warnings, then the rest, each in the order they had. */
export function problemsFirst(items: OverviewItem[]): OverviewItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => problemRank(a.item) - problemRank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * The boxes a search finds, by name, bundle key or type, ignoring case. `null` while nothing is
 * typed, so the overview shows as usual.
 */
export function findMatches(overview: BundleOverview, query: string): Set<string> | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  return new Set(
    allItems(overview)
      // The type words too ("cluster", "SQL warehouse"), as the search list matches them.
      .filter((item) => `${item.label} ${item.resourceKey ?? ""} ${typeWords(item)}`.toLowerCase().includes(needle))
      .map((item) => item.id),
  );
}

/** The boxes with an error or warning, and the boxes linked to those, which give them context. */
export function problemContext(overview: BundleOverview): Set<string> {
  const ids = new Set<string>();
  for (const item of allItems(overview)) {
    if (item.problems.errors + item.problems.warnings === 0) continue;
    ids.add(item.id);
    for (const id of linkedIds(overview, item.id)) ids.add(id);
  }
  return ids;
}

/** The matches and what they link to: what stays lit while a search is typed. */
export function litByFind(overview: BundleOverview, matches: Set<string>): Set<string> {
  const ids = new Set(matches);
  for (const id of matches) for (const linked of linkedIds(overview, id)) ids.add(linked);
  return ids;
}

/**
 * What Issues says when no box has a problem. Problems can belong to the bundle itself
 * (a bundle-wide CLI error, for example), and then "no problems" would be wrong.
 */
export function noBoxProblemsWords(overview: BundleOverview): string {
  return overview.bundleWide.errors + overview.bundleWide.warnings > 0
    ? "No resource has a problem. The bundle's own problems are in the Issues list."
    : "No problems found in this bundle.";
}

/** The folded group holding the selected box, which opens so the box is not hidden. */
export function groupOfSelected(overview: BundleOverview, selectedId: string | null | undefined): string | undefined {
  if (!selectedId) return undefined;
  return overview.groups.find((group) => group.items.some((item) => item.id === selectedId))?.id;
}
