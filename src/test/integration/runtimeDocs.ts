import type { RuntimeRelease } from "../../bundle/runtimeSupport.js";

/**
 * Reads the Databricks Runtime versions and their dates from the two docs pages the shipped
 * table comes from (#485), so a weekly job can compare them. The pages leave out closing
 * `</tr>` and `</td>` tags, and print each table twice (wide and narrow screens).
 */

export const RUNTIME_DOCS_PAGES = {
  supported: "https://docs.databricks.com/aws/en/release-notes/runtime/",
  endOfSupport: "https://docs.databricks.com/aws/en/release-notes/runtime/eos",
} as const;

/** The sentence the end-of-life rule in runtimeSupport.ts rests on. */
export const END_OF_LIFE_SENTENCE = "Databricks Runtime 10.4 LTS and earlier have reached end-of-life";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const text = (cell: string) =>
  cell
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => entities[name]!)
    .replace(/\s+/g, " ")
    .trim();

/** "June 10, 2029" or "Sep 11, 2026" as 2029-06-10; anything else (such as "Not yet announced") as undefined. */
export function docsDate(value: string): string | undefined {
  const match = /^([A-Za-z]+)\.? (\d{1,2}), (\d{4})$/.exec(value.trim());
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[1]!.slice(0, 3).toLowerCase());
  if (month < 0) return undefined;
  return `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
}

/** Each table on the page as rows of cell texts, its header row first. */
export function htmlTables(html: string): string[][][] {
  return [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map(([table]) =>
    table
      .split(/<tr[^>]*>/)
      .slice(1)
      .map((row) => row.split(/<t[hd][^>]*>/).slice(1).map(text)),
  );
}

/**
 * The versions in the tables whose header has "Version" and "End-of-support date": the
 * supported list, and the end-of-support list, which also has "End-of-life date".
 */
export function runtimeReleasesFromDocs(html: string): Record<string, RuntimeRelease> {
  const releases: Record<string, RuntimeRelease> = {};
  for (const [header = [], ...rows] of htmlTables(html)) {
    const column = (name: string) => header.findIndex((cell) => cell.toLowerCase() === name);
    const [version, eos, eol] = [column("version"), column("end-of-support date"), column("end-of-life date")];
    if (version < 0 || eos < 0) continue;
    for (const row of rows) {
      const label = /^(\d+(?:\.\d+)?)( LTS)?$/.exec(row[version] ?? "");
      if (!label) continue;
      const endOfSupport = docsDate(row[eos] ?? "");
      const endOfLife = eol < 0 ? undefined : docsDate(row[eol] ?? "");
      releases[label[1]!] = {
        lts: Boolean(label[2]),
        ...(endOfSupport ? { endOfSupport } : {}),
        ...(endOfLife ? { endOfLife } : {}),
      };
    }
  }
  return releases;
}
