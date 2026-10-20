/**
 * Whether a bundle the CLI printed for a real target, after an error, is complete enough to
 * show as that target.
 *
 * The CLI builds a target in a fixed order and stops at its first error, then prints the
 * bundle as far as it got. Two things decide whether that is usable:
 *
 * - It got past the login step (`PopulateCurrentUser`), which sets `workspace.current_user`.
 *   Before that, nothing from the workspace was checked and variables are not filled in.
 * - Nothing is left for the CLI's merge steps to do. A target's override of a task, cluster
 *   or parameter is appended to the list and only merged later, by key. With no two items
 *   sharing a key, merging would change nothing (apart from task order), so a run that
 *   stopped before merging still shows the right items.
 *
 * The keys follow the CLI's own rules (`bundle/config/mutator/resourcemutator/merge_*.go`,
 * checked at 1.21.0): a missing key counts as "", pipeline cluster labels are compared in
 * lower case with a missing label as "default".
 */
export function cliAppliedTarget(bundle: unknown): boolean {
  const root = asRecord(bundle);
  if (!asRecord(asRecord(root?.workspace)?.current_user)) return false;
  return !hasUnmergedItems(asRecord(root?.resources));
}

function hasUnmergedItems(resources: Record<string, unknown> | undefined): boolean {
  const plainKey = (field: string) => (item: unknown) => {
    const value = asRecord(item)?.[field];
    return typeof value === "string" ? value : "";
  };
  const lists: Array<[resourceType: string, listField: string, key: (item: unknown) => string]> = [
    ["jobs", "tasks", plainKey("task_key")],
    ["jobs", "job_clusters", plainKey("job_cluster_key")],
    ["jobs", "parameters", plainKey("name")],
    ["pipelines", "clusters", (item) => {
      const label = asRecord(item)?.label;
      return typeof label === "string" ? label.toLowerCase() : "default";
    }],
    ["apps", "resources", plainKey("name")],
    ...["catalogs", "schemas", "external_locations", "secrets", "volumes", "registered_models", "vector_search_indexes"]
      .map((type): [string, string, (item: unknown) => string] => [type, "grants", plainKey("principal")]),
  ];
  return lists.some(([resourceType, listField, key]) =>
    Object.values(asRecord(resources?.[resourceType]) ?? {}).some((resource) => {
      const items = asRecord(resource)?.[listField];
      if (!Array.isArray(items)) return false;
      const keys = items.map(key);
      return new Set(keys).size !== keys.length;
    }),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
