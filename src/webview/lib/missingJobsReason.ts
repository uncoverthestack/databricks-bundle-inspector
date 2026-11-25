/**
 * Why a bundle with no jobs or pipelines on screen may still have some (issue 549).
 *
 * The structural preview merges no target and never runs the bundle's Python, so jobs set
 * only under `targets.<name>.resources`, or returned by the `python.resources` functions, are
 * not in `resources`. The CLI's output still lists both, so the empty panel can say why
 * rather than claim the bundle defines neither.
 */

const NAMES_SHOWN = 3;

interface BundleOutput {
  python?: { resources?: unknown } | null;
  targets?: Record<string, { resources?: Record<string, unknown> | null } | null> | null;
}

const hasEntries = (value: unknown): boolean =>
  typeof value === "object" && value !== null && Object.keys(value).length > 0;

/** "the dev target", "the dev and prod targets", "the a, b, c and 2 more targets". */
function targetWords(names: string[]): string {
  if (names.length === 1) return `the ${names[0]} target`;
  const shown = names.slice(0, NAMES_SHOWN);
  const rest = names.length - shown.length;
  const list = rest > 0 ? `${shown.join(", ")} and ${rest} more` : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
  return `the ${list} targets`;
}

/**
 * The line to show under "No jobs or pipelines found in this bundle.", or undefined when the
 * bundle really has none. Python comes first: picking a target never brings those back.
 * `currentTarget` is left out of the targets named, since its resources are already merged.
 */
export function missingJobsReason(bundle: BundleOutput | null | undefined, currentTarget?: string): string | undefined {
  const python = bundle?.python?.resources;
  if (Array.isArray(python) && python.length > 0) {
    return "Jobs defined in Python may be missing: the inspector doesn't run bundle code.";
  }
  const holding = Object.entries(bundle?.targets ?? {}).filter(([name, target]) => {
    if (name === currentTarget) return false;
    const resources = target?.resources;
    return hasEntries(resources?.jobs) || hasEntries(resources?.pipelines);
  });
  if (holding.length === 0) return undefined;
  const jobs = holding.some(([, target]) => hasEntries(target?.resources?.jobs));
  const what = jobs ? "Jobs" : "Pipelines";
  const names = holding.map(([name]) => name);
  return `${what} set inside ${targetWords(names)} may be missing until you pick ${names.length === 1 ? "it" : "one"}.`;
}
