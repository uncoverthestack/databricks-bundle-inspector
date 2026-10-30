/** A `depends_on` arrow: `target` waits on `source`. */
export interface DependencyEdge {
  source: string;
  target: string;
}

/**
 * Each task's column in the graph: its longest run of upstream tasks. A task met again
 * while its own column is still being worked out closes a loop and counts as 0 there,
 * so a loop still ends.
 */
export function taskLevels(taskIds: string[], edges: DependencyEdge[]): Map<string, number> {
  const upstream = new Map<string, string[]>();
  for (const edge of edges) upstream.set(edge.target, [...(upstream.get(edge.target) ?? []), edge.source]);
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  function level(id: string): number {
    const known = levels.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const sources = upstream.get(id) ?? [];
    const lv = sources.length === 0 ? 0 : Math.max(...sources.map(level)) + 1;
    levels.set(id, lv);
    return lv;
  }
  taskIds.forEach(level);
  return levels;
}

/**
 * Whether the graph draws this arrow. A job is a DAG, so arrows only point to a later
 * column. One that doesn't closes a loop, or is a task waiting on itself, which the loop
 * check already reports as an error; drawn, it would run under the boxes and show only
 * its arrowhead.
 */
export function isDrawnDependency(edge: DependencyEdge, levels: Map<string, number>): boolean {
  return (levels.get(edge.source) ?? 0) < (levels.get(edge.target) ?? 0);
}
