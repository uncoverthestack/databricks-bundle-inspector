/**
 * Lakebase projects and their branches (issue 543): which branch each branch was made from,
 * and what each branch holds, read from the bundle's `postgres_*` resources only.
 *
 * Paths are written two ways, and both are followed:
 * - a reference the CLI fills in at deploy: `${resources.postgres_projects.p.id}/branches/production`,
 *   `${resources.postgres_branches.dev.id}`;
 * - a plain path: `projects/orders-db/branches/dev`.
 *
 * From the CLI v1.28.0 schema: a project creates its first branch itself, named by
 * `default_branch` or `production` when that is left out; a branch with no `source_branch`
 * is made from the project's default branch; a snapshot is `projects/{id}/snapshots/{id}`.
 * Nothing else is assumed: a time, LSN or snapshot shows only when the bundle sets it.
 */

export interface LakebaseGraphNode {
  id: string;
  resourceGroup?: string | undefined;
  resourceKey?: string | undefined;
  data?: Record<string, unknown> | undefined;
  sourceFile?: string | undefined;
  sourceLine?: number | undefined;
  fieldLines?: Record<string, number> | undefined;
}

export interface LakebaseGraphEdge {
  source: string;
  target: string;
  kind: string;
}

/**
 * Where a branch row comes from:
 * - `bundle`: a `postgres_branches` resource;
 * - `project`: the first branch, which the project creates itself;
 * - `outside`: a branch the bundle names but doesn't define.
 */
export type BranchOrigin = "bundle" | "project" | "outside";

/** What a branch was made from. */
export type BranchSource =
  | { kind: "branch"; branchId: string; label: string; lsn?: string; time?: string; implicit: boolean }
  | { kind: "snapshot"; label: string }
  | { kind: "none" };

export interface LakebaseEndpoint {
  id: string;
  label: string;
  readWrite: boolean;
  /** `read-write`, `read-only`, or the type as written. */
  typeWords: string;
  /** `0.5 to 2 CU`, when set. */
  capacity?: string;
  /** `suspends after 5 min`, `never suspends`, when set. */
  suspend?: string;
  file?: string;
  line?: number;
}

/** A database, role, synced table, catalog or Data API on a branch. */
export interface LakebaseHeld {
  id: string;
  group: string;
  label: string;
  /** One short fact, such as `synced from main.sales.orders`. */
  detail?: string;
  file?: string;
  line?: number;
}

export interface LakebaseSchedule {
  id: string;
  label: string;
  /** `Daily at 03:00 UTC, kept 7 days`, one per cadence. */
  cadences: string[];
  file?: string;
  line?: number;
}

export interface LakebaseBranch {
  /** The resource's id, or `<project id>#branch:<branch id>` for a branch the bundle doesn't define. */
  id: string;
  origin: BranchOrigin;
  /** The resource key for a bundle branch, else the branch ID. */
  label: string;
  /** `branch_id` as written, which can hold `${...}`. */
  branchId?: string;
  isDefault: boolean;
  isProtected: boolean;
  source: BranchSource;
  /** `ttl: 604800s` → `7 days after it's created`; `expire_time`; `no_expiry`. */
  expiry?: { kind: "ttl" | "time" | "never"; text: string };
  endpoints: LakebaseEndpoint[];
  held: LakebaseHeld[];
  schedules: LakebaseSchedule[];
  /** Resources outside Lakebase that use this branch or something on it. */
  usedBy: Array<{ id: string; label: string; through?: string }>;
  file?: string;
  line?: number;
}

export interface LakebaseProject {
  id: string;
  key: string;
  label: string;
  /** `project_id` as written. */
  projectId?: string;
  displayName?: string;
  pgVersion?: string;
  /** `7 days`, when `history_retention_duration` is set. */
  history?: string;
  branches: LakebaseBranch[];
  /** Branches made from another branch, in tree order, with their depth (0 for a root). */
  tree: Array<{ id: string; depth: number }>;
  /** Branches made from a snapshot. */
  fromSnapshot: string[];
  /** Every resource shown inside this project instead of as its own box on the overview. */
  memberIds: string[];
  file?: string;
  line?: number;
}

/** The project's first branch when `default_branch` is left out (CLI v1.28.0 schema). */
export const FIRST_BRANCH = "production";

/** Resources that live on a branch, with the field that names it. */
const ON_BRANCH: ReadonlyArray<{ group: string; field: string }> = [
  { group: "postgres_endpoints", field: "parent" },
  { group: "postgres_databases", field: "parent" },
  { group: "postgres_roles", field: "parent" },
  { group: "postgres_synced_tables", field: "branch" },
  { group: "postgres_catalogs", field: "branch" },
  { group: "postgres_snapshot_schedules", field: "branch" },
  { group: "postgres_data_apis", field: "parent" },
];

const REFERENCE = /^\$\{resources\.([a-z_]+)\.([^.}]+)\.(?:id|name)\}/;

/** The parts of a Lakebase path, each either a bundle resource key or the text as written. */
interface PathParts {
  projectKey?: string;
  projectText?: string;
  branchKey?: string;
  branchText?: string;
  databaseKey?: string;
  databaseText?: string;
  snapshotText?: string;
}

export function parseLakebasePath(value: unknown): PathParts | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const parts: PathParts = {};
  let rest = value;
  const reference = REFERENCE.exec(rest);
  if (reference) {
    const [, group, key] = reference;
    if (group === "postgres_projects") parts.projectKey = key!;
    else if (group === "postgres_branches") parts.branchKey = key!;
    else if (group === "postgres_databases") parts.databaseKey = key!;
    else return undefined;
    rest = rest.slice(reference[0].length);
  } else {
    const project = /^projects\/([^/]+)/.exec(rest);
    if (!project) return undefined;
    parts.projectText = project[1]!;
    rest = rest.slice(project[0].length);
  }
  for (;;) {
    const step = /^\/(branches|databases|snapshots)\/([^/]+)/.exec(rest);
    if (!step) break;
    if (step[1] === "branches") parts.branchText = step[2]!;
    else if (step[1] === "databases") parts.databaseText = step[2]!;
    else parts.snapshotText = step[2]!;
    rest = rest.slice(step[0].length);
  }
  return parts;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** `604800s` → `7 days`, `300s` → `5 min`, `5400s` → `90 min`. Anything else as written. */
export function durationWords(value: unknown): string | undefined {
  const written = text(value);
  if (!written) return undefined;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(written.trim());
  if (!match) return written;
  const seconds = Number(match[1]);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (seconds >= 86400 && seconds % 86400 === 0) return plural(seconds / 86400, "day");
  if (seconds >= 3600 && seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`;
  return plural(seconds, "second");
}

function hourWords(hour: unknown): string {
  return typeof hour === "number" && Number.isInteger(hour) ? ` at ${String(hour).padStart(2, "0")}:00 UTC` : "";
}

const WEEKDAY = /^(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)$/i;

/** One `schedule` entry in words: `Daily at 03:00 UTC, kept 7 days`. */
export function cadenceWords(cadence: unknown): string | undefined {
  if (!cadence || typeof cadence !== "object") return undefined;
  const entry = cadence as Record<string, unknown>;
  const record = (key: string) => (entry[key] && typeof entry[key] === "object" ? (entry[key] as Record<string, unknown>) : undefined);
  const daily = record("daily_schedule");
  const weekly = record("weekly_schedule");
  const monthly = record("monthly_schedule");
  let when: string | undefined;
  if (daily) when = `Daily${hourWords(daily.hour)}`;
  else if (weekly) {
    const day = typeof weekly.day_of_week === "string" && WEEKDAY.test(weekly.day_of_week)
      ? ` on ${weekly.day_of_week.charAt(0)}${weekly.day_of_week.slice(1).toLowerCase()}`
      : "";
    when = `Weekly${day}${hourWords(weekly.hour)}`;
  } else if (monthly) {
    when = `Monthly${typeof monthly.day === "number" ? ` on day ${monthly.day}` : ""}${hourWords(monthly.hour)}`;
  }
  if (!when) return undefined;
  const kept = durationWords(entry.retention);
  return kept ? `${when}, kept ${kept}` : when;
}

function endpointOf(node: LakebaseGraphNode): LakebaseEndpoint {
  const data = node.data ?? {};
  const type = text(data.endpoint_type) ?? "";
  const readWrite = /READ_WRITE$/.test(type);
  const min = text(data.autoscaling_limit_min_cu);
  const max = text(data.autoscaling_limit_max_cu);
  const capacity = min && max ? `${min} to ${max} CU` : min ? `at least ${min} CU` : max ? `up to ${max} CU` : undefined;
  const suspend = data.no_suspension === true
    ? "never suspends"
    : durationWords(data.suspend_timeout_duration)
      ? `suspends after ${durationWords(data.suspend_timeout_duration)}`
      : undefined;
  return {
    id: node.id,
    label: node.resourceKey ?? node.id,
    readWrite,
    typeWords: readWrite ? "read-write" : /READ_ONLY$/.test(type) ? "read-only" : type || "endpoint",
    ...(capacity ? { capacity } : {}),
    ...(suspend ? { suspend } : {}),
    ...(node.sourceFile ? { file: node.sourceFile } : {}),
    ...(node.sourceLine ? { line: node.sourceLine } : {}),
  };
}

function heldOf(node: LakebaseGraphNode): LakebaseHeld {
  const data = node.data ?? {};
  const group = node.resourceGroup ?? "";
  let detail: string | undefined;
  if (group === "postgres_synced_tables") {
    const from = text(data.source_table_full_name);
    detail = from ? `synced from ${from}` : undefined;
  } else if (group === "postgres_databases") {
    detail = text(data.postgres_database) ? `database ${text(data.postgres_database)}` : undefined;
  } else if (group === "postgres_roles") {
    detail = text(data.postgres_role) ? `role ${text(data.postgres_role)}` : undefined;
  } else if (group === "postgres_catalogs") {
    detail = text(data.catalog_id) ? `catalog ${text(data.catalog_id)}` : undefined;
  }
  return {
    id: node.id,
    group,
    label: node.resourceKey ?? node.id,
    ...(detail ? { detail } : {}),
    ...(node.sourceFile ? { file: node.sourceFile } : {}),
    ...(node.sourceLine ? { line: node.sourceLine } : {}),
  };
}

/**
 * Every Lakebase project the bundle defines, with its branches.
 *
 * @param resolve Turns an expression into its value for the shown target, so `dev-${workspace.current_user.short_name}`
 *   written in two places compares equal. Identity when unknown.
 */
export function buildLakebaseProjects(
  nodes: readonly LakebaseGraphNode[],
  edges: readonly LakebaseGraphEdge[] = [],
  resolve: (value: string) => string = (value) => value,
): LakebaseProject[] {
  const byGroup = (group: string) => nodes.filter((node) => node.resourceGroup === group && node.resourceKey && node.id === `resources.${group}.${node.resourceKey}`);
  const same = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && resolve(a) === resolve(b);

  const projectNodes = byGroup("postgres_projects");
  const branchNodes = byGroup("postgres_branches");
  const databaseNodes = byGroup("postgres_databases");
  if (projectNodes.length === 0) return [];

  const projects = new Map<string, LakebaseProject>();
  const branchesOf = new Map<string, Map<string, LakebaseBranch>>();
  const defaultTextOf = new Map<string, string>();

  for (const node of projectNodes) {
    const data = node.data ?? {};
    const defaultPath = parseLakebasePath(data.default_branch);
    defaultTextOf.set(node.id, defaultPath?.branchText ?? FIRST_BRANCH);
    const pgVersion = text(data.pg_version);
    const history = durationWords(data.history_retention_duration);
    const projectId = text(data.project_id);
    const displayName = text(data.display_name);
    projects.set(node.id, {
      id: node.id,
      key: node.resourceKey!,
      label: node.resourceKey!,
      ...(projectId ? { projectId } : {}),
      ...(displayName ? { displayName } : {}),
      ...(pgVersion ? { pgVersion } : {}),
      ...(history ? { history } : {}),
      branches: [],
      tree: [],
      fromSnapshot: [],
      memberIds: [],
      ...(node.sourceFile ? { file: node.sourceFile } : {}),
      ...(node.sourceLine ? { line: node.sourceLine } : {}),
    });
    branchesOf.set(node.id, new Map());
  }

  /** The bundle project a path names. */
  const projectOf = (parts: PathParts | undefined): string | undefined => {
    if (!parts) return undefined;
    if (parts.projectKey) {
      const id = `resources.postgres_projects.${parts.projectKey}`;
      return projects.has(id) ? id : undefined;
    }
    if (parts.projectText) return projectNodes.find((node) => same(text(node.data?.project_id), parts.projectText))?.id;
    if (parts.branchKey) return branchProject.get(`resources.postgres_branches.${parts.branchKey}`);
    if (parts.databaseKey) {
      const database = databaseNodes.find((node) => node.resourceKey === parts.databaseKey);
      return projectOf(parseLakebasePath(database?.data?.parent));
    }
    return undefined;
  };

  // 1. The bundle's branches, each in the project its `parent` names.
  const branchProject = new Map<string, string>();
  for (const node of branchNodes) {
    const projectId = projectOf(parseLakebasePath(node.data?.parent));
    if (!projectId) continue;
    branchProject.set(node.id, projectId);
    const data = node.data ?? {};
    const branchId = text(data.branch_id);
    const branch: LakebaseBranch = {
      id: node.id,
      origin: "bundle",
      label: node.resourceKey!,
      ...(branchId ? { branchId } : {}),
      isDefault: false,
      isProtected: data.is_protected === true,
      source: { kind: "none" },
      endpoints: [],
      held: [],
      schedules: [],
      usedBy: [],
      ...(node.sourceFile ? { file: node.sourceFile } : {}),
      ...(node.sourceLine ? { line: node.sourceLine } : {}),
    };
    const ttl = durationWords(data.ttl);
    const expireTime = text(data.expire_time);
    if (ttl) branch.expiry = { kind: "ttl", text: `Expires ${ttl} after it's created` };
    else if (expireTime) branch.expiry = { kind: "time", text: `Expires ${expireTime}` };
    else if (data.no_expiry === true) branch.expiry = { kind: "never", text: "Never expires" };
    branchesOf.get(projectId)!.set(node.id, branch);
    projects.get(projectId)!.memberIds.push(node.id);
  }

  /** The branch row a branch ID names in a project: the bundle's, the project's first, or one from outside. */
  const branchByText = (projectId: string, branchText: string): LakebaseBranch => {
    const branches = branchesOf.get(projectId)!;
    for (const branch of branches.values()) {
      if (branch.origin === "bundle" ? same(branch.branchId, branchText) : branch.label === resolve(branchText)) return branch;
    }
    const isFirst = same(defaultTextOf.get(projectId), branchText);
    const label = resolve(branchText);
    const branch: LakebaseBranch = {
      id: `${projectId}#branch:${label}`,
      origin: isFirst ? "project" : "outside",
      label,
      branchId: branchText,
      isDefault: false,
      isProtected: false,
      source: { kind: "none" },
      endpoints: [],
      held: [],
      schedules: [],
      usedBy: [],
    };
    branches.set(branch.id, branch);
    return branch;
  };

  /** The branch a path names, in the project it names. */
  const branchOf = (parts: PathParts | undefined): { projectId: string; branch: LakebaseBranch } | undefined => {
    if (!parts) return undefined;
    if (parts.branchKey) {
      const id = `resources.postgres_branches.${parts.branchKey}`;
      const projectId = branchProject.get(id);
      return projectId ? { projectId, branch: branchesOf.get(projectId)!.get(id)! } : undefined;
    }
    if (parts.databaseKey) {
      const database = databaseNodes.find((node) => node.resourceKey === parts.databaseKey);
      return branchOf(parseLakebasePath(database?.data?.parent));
    }
    const projectId = projectOf(parts);
    if (!projectId || !parts.branchText) return undefined;
    return { projectId, branch: branchByText(projectId, parts.branchText) };
  };

  // 2. The default branch of each project. It exists even when the bundle doesn't define it.
  for (const projectId of projects.keys()) {
    branchByText(projectId, defaultTextOf.get(projectId)!).isDefault = true;
  }

  // 3. Where each bundle branch was made from.
  for (const node of branchNodes) {
    const projectId = branchProject.get(node.id);
    if (!projectId) continue;
    const branch = branchesOf.get(projectId)!.get(node.id)!;
    const data = node.data ?? {};
    const snapshot = parseLakebasePath(data.source_snapshot);
    if (snapshot?.snapshotText || text(data.source_snapshot)) {
      branch.source = { kind: "snapshot", label: snapshot?.snapshotText ? resolve(snapshot.snapshotText) : resolve(text(data.source_snapshot)!) };
      continue;
    }
    if (branch.isDefault) continue;
    const named = text(data.source_branch) ? branchOf(parseLakebasePath(data.source_branch)) : undefined;
    // No `source_branch`: the schema says the branch is made from the project's default branch.
    const from = named?.projectId === projectId ? named.branch : !text(data.source_branch) ? branchByText(projectId, defaultTextOf.get(projectId)!) : undefined;
    if (!from || from.id === branch.id) continue;
    const lsn = text(data.source_branch_lsn);
    const time = text(data.source_branch_time);
    branch.source = {
      kind: "branch",
      branchId: from.id,
      label: from.label,
      ...(lsn ? { lsn } : {}),
      ...(time ? { time } : {}),
      implicit: !text(data.source_branch),
    };
  }

  // 4. What each branch holds.
  const owner = new Map<string, LakebaseBranch>();
  for (const { group, field } of ON_BRANCH) {
    for (const node of byGroup(group)) {
      const found = branchOf(parseLakebasePath(node.data?.[field]));
      if (!found) continue;
      const { projectId, branch } = found;
      projects.get(projectId)!.memberIds.push(node.id);
      owner.set(node.id, branch);
      if (group === "postgres_endpoints") branch.endpoints.push(endpointOf(node));
      else if (group === "postgres_snapshot_schedules") {
        const cadences = (Array.isArray(node.data?.schedule) ? node.data!.schedule : []).map(cadenceWords).filter((words): words is string => Boolean(words));
        branch.schedules.push({
          id: node.id,
          label: node.resourceKey!,
          cadences,
          ...(node.sourceFile ? { file: node.sourceFile } : {}),
          ...(node.sourceLine ? { line: node.sourceLine } : {}),
        });
      } else branch.held.push(heldOf(node));
    }
  }
  for (const [branchId, projectId] of branchProject) owner.set(branchId, branchesOf.get(projectId)!.get(branchId)!);

  // 5. What outside Lakebase uses each branch, directly or through something on it.
  const members = new Set([...projects.values()].flatMap((project) => [project.id, ...project.memberIds]));
  const labelOf = (id: string) => nodes.find((node) => node.id === id)?.resourceKey ?? id;
  for (const edge of edges) {
    if (edge.kind !== "references" && edge.kind !== "uses") continue;
    const branch = owner.get(edge.target);
    if (!branch || members.has(edge.source) || !/^resources\.[^.]+\.[^.]+$/.test(edge.source)) continue;
    if (branch.usedBy.some((use) => use.id === edge.source)) continue;
    branch.usedBy.push({ id: edge.source, label: labelOf(edge.source), ...(edge.target !== branch.id ? { through: labelOf(edge.target) } : {}) });
  }

  // 6. Tree order: each branch under the one it was made from, the default branch first.
  for (const project of projects.values()) {
    const branches = [...branchesOf.get(project.id)!.values()];
    project.branches = branches;
    const children = new Map<string, LakebaseBranch[]>();
    const roots: LakebaseBranch[] = [];
    for (const branch of branches) {
      if (branch.source.kind === "snapshot") {
        project.fromSnapshot.push(branch.id);
        continue;
      }
      const parent = branch.source.kind === "branch" ? branch.source.branchId : undefined;
      if (parent) children.set(parent, [...(children.get(parent) ?? []), branch]);
      else roots.push(branch);
    }
    roots.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    const seen = new Set<string>();
    const visit = (branch: LakebaseBranch, depth: number) => {
      if (seen.has(branch.id)) return;
      seen.add(branch.id);
      project.tree.push({ id: branch.id, depth });
      for (const child of children.get(branch.id) ?? []) visit(child, depth + 1);
    };
    for (const root of roots) visit(root, 0);
    // A loop of branches each made from the next has no root; list them flat rather than lose them.
    for (const branch of branches) if (branch.source.kind !== "snapshot" && !seen.has(branch.id)) visit(branch, 0);
  }

  return [...projects.values()];
}

/** The branch a branch row is, by id. */
export function branchById(project: LakebaseProject, id: string): LakebaseBranch | undefined {
  return project.branches.find((branch) => branch.id === id);
}

/** `3 branches · 1 made from a snapshot`. */
export function branchCountWords(project: LakebaseProject): string {
  const inTree = project.tree.length;
  const snapshots = project.fromSnapshot.length;
  const branches = `${inTree} branch${inTree === 1 ? "" : "es"}`;
  return snapshots ? `${branches} · ${snapshots} from a snapshot` : branches;
}

/** The one line under a branch's name saying where it came from. */
export function sourceWords(branch: LakebaseBranch): string {
  if (branch.origin === "project") return "Made with the project";
  if (branch.origin === "outside") return "Not in this bundle";
  const source = branch.source;
  if (source.kind === "snapshot") return `From snapshot ${source.label}`;
  if (source.kind === "branch") {
    const at = source.lsn ? ` at LSN ${source.lsn}` : source.time ? ` at ${source.time}` : "";
    return `From ${source.label}${at}`;
  }
  return branch.isDefault ? "The project's default branch" : "";
}

/** The grey states at the right of a branch's row. */
export function branchStates(branch: LakebaseBranch): string[] {
  const states: string[] = [];
  if (branch.expiry && branch.expiry.kind !== "never") states.push(branch.expiry.text);
  // The project gives its first branch an endpoint itself, so only other branches are noted.
  if (branch.origin === "bundle" && !branch.isDefault && !branch.endpoints.some((endpoint) => endpoint.readWrite)) {
    states.push("No read-write endpoint in this bundle");
  }
  return states;
}

/** `app_db · used by orders_app`: what a branch holds and who uses it, in one line. */
export function holdsWords(branch: LakebaseBranch): string {
  const held = branch.held.filter((item) => item.group === "postgres_databases" || item.group === "postgres_synced_tables").map((item) => item.label);
  const users = branch.usedBy.map((use) => use.label);
  return [...held, users.length ? `used by ${users.join(", ")}` : ""].filter(Boolean).join(" · ");
}
