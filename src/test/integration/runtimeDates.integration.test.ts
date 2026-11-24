import { describe, expect, test } from "@jest/globals";
import { RUNTIME_DATES_CHECKED, RUNTIME_RELEASES } from "../../bundle/runtimeSupport.js";
import { END_OF_LIFE_SENTENCE, RUNTIME_DOCS_PAGES, runtimeReleasesFromDocs } from "./runtimeDocs.js";

/**
 * The weekly check behind `runtime_end_of_support` (#485): the versions and dates the
 * extension ships are the ones on the Databricks docs pages today. A new version, a moved
 * date, or an end-of-life date being announced fails this, so the table is updated by hand
 * (with RUNTIME_DATES_CHECKED) instead of going stale. Reads the network: not part of the
 * unit tests. Run with `npm run test:runtime-dates`.
 */

async function page(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": "databricks-bundle-inspector-ci" } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

describe(`Databricks Runtime dates (table checked ${RUNTIME_DATES_CHECKED})`, () => {
  test("the shipped table matches the docs pages", async () => {
    const [supported, endOfSupport] = await Promise.all([page(RUNTIME_DOCS_PAGES.supported), page(RUNTIME_DOCS_PAGES.endOfSupport)]);
    const docs = { ...runtimeReleasesFromDocs(endOfSupport), ...runtimeReleasesFromDocs(supported) };

    // A layout change that reads nothing would otherwise look like "every version removed".
    expect(Object.keys(runtimeReleasesFromDocs(supported)).length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(runtimeReleasesFromDocs(endOfSupport)).length).toBeGreaterThanOrEqual(20);

    // Sorted, so a failure reads as a list of the versions that differ.
    const sorted = (releases: Record<string, unknown>) => Object.fromEntries(Object.entries(releases).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })));
    expect(sorted(RUNTIME_RELEASES)).toEqual(sorted(docs));
  });

  test("Databricks still says 10.4 LTS and earlier are past end of life", async () => {
    const text = (await page(RUNTIME_DOCS_PAGES.endOfSupport)).replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    expect(text).toContain(END_OF_LIFE_SENTENCE);
  });
});
