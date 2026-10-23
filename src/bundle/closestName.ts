export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/** The candidate a name was most likely meant to be, if one is close: a widget, a task key. */
export function closestName(name: string, candidates: string[]): string | undefined {
  const normalise = (value: string) => value.toLowerCase().replace(/[-_\s]/g, "");
  let best: { candidate: string; distance: number; exact: number } | undefined;
  for (const candidate of candidates) {
    const [n, c] = [normalise(name), normalise(candidate)];
    // Same name up to case and separators, or one extends the other (schema, schema_name).
    const distance = n === c ? 0 : n.includes(c) || c.includes(n) ? 1 : editDistance(name, candidate);
    if (distance > Math.max(2, Math.floor(name.length / 3))) continue;
    // A tie goes to the closer spelling, then the first alphabetically, so the order the
    // candidates come in (a real target sorts tasks) never changes the suggestion.
    const exact = editDistance(name, candidate);
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && (exact < best.exact || (exact === best.exact && candidate < best.candidate)))
    ) {
      best = { candidate, distance, exact };
    }
  }
  return best?.candidate;
}
