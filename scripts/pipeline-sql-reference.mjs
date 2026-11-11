#!/usr/bin/env node
// Tracks the Databricks pipeline SQL reference, which src/bundle/pipelineSql.ts follows
// (issue 398). The inspector reads pipeline SQL with its own small parser, so a change in
// Databricks' syntax must show up as a failing check, not as a wrong picture.
//
//   node scripts/pipeline-sql-reference.mjs           compare the live pages with the snapshot
//   node scripts/pipeline-sql-reference.mjs --update  save the live pages as the new snapshot
//
// The snapshot keeps each statement page's code blocks (its syntax and Databricks' own
// examples). src/test/unit/extension/pipelineSqlReference.test.ts runs the parser over those
// examples on every push, without the network. The weekly CLI compatibility run does the
// comparison. The AWS and GCP copies of these pages were identical on 2026-11-11.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = "https://docs.databricks.com";
const INDEX = "/gcp/en/ldp/developer/sql-ref";
const SNAPSHOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/test/fixtures/pipeline-sql-reference.json");

async function fetchText(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "databricks-bundle-inspector docs check" } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      if (attempt >= 3) throw new Error(`Could not fetch ${url}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

const decode = (text) =>
  text
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/​/g, "")
    .split("\n").map((line) => line.replace(/\s+$/, "")).join("\n")
    .trim();

/** Each code block on a page, with the h2 or h3 heading it sits under. */
function codeBlocks(page) {
  const blocks = [];
  let heading = "";
  const pattern = /<h[23][^>]*>([\s\S]*?)<\/h[23]>|<pre[^>]*>([\s\S]*?)<\/pre>/g;
  for (let match; (match = pattern.exec(page)); ) {
    if (match[1] !== undefined) heading = decode(match[1]);
    else blocks.push({ heading, code: decode(match[2]) });
  }
  return blocks;
}

async function live() {
  const index = await fetchText(SITE + INDEX);
  const links = [...new Set([...index.matchAll(/href="?(\/gcp\/en\/(?:ldp\/developer\/ldp-sql-ref-[\w-]+|sql\/language-manual\/sql-ref-syntax-[\w-]+))/g)].map((m) => m[1]))].sort();
  if (!links.some((link) => link.includes("ldp-sql-ref-"))) throw new Error(`No statement links found on ${SITE + INDEX}; the page layout may have changed.`);
  const pages = {};
  for (const link of links) {
    // Statements that run outside a pipeline are tracked by name only.
    if (!link.includes("/ldp/developer/")) { pages[link] = { outsidePipelines: true }; continue; }
    const page = await fetchText(SITE + link);
    const title = decode(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(page)?.[1] ?? "");
    const blocks = codeBlocks(page);
    if (blocks.length === 0) throw new Error(`No code blocks on ${SITE + link}; the page layout may have changed.`);
    pages[link] = { title, blocks };
  }
  return { source: SITE + INDEX, pages };
}

function compare(saved, now) {
  const lines = [];
  const keys = [...new Set([...Object.keys(saved.pages), ...Object.keys(now.pages)])].sort();
  for (const key of keys) {
    const before = saved.pages[key];
    const after = now.pages[key];
    if (!before) { lines.push(`NEW statement page: ${SITE + key}`); continue; }
    if (!after) { lines.push(`REMOVED statement page: ${SITE + key}`); continue; }
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    lines.push(`CHANGED: ${SITE + key}`);
    const count = Math.max(before.blocks?.length ?? 0, after.blocks?.length ?? 0);
    for (let i = 0; i < count; i++) {
      const a = before.blocks?.[i]; const b = after.blocks?.[i];
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      lines.push(`  block ${i + 1} (${b?.heading ?? a?.heading ?? "?"}):`);
      const aLines = (a?.code ?? "").split("\n"); const bLines = (b?.code ?? "").split("\n");
      for (const line of aLines) if (!bLines.includes(line)) lines.push(`    - ${line}`);
      for (const line of bLines) if (!aLines.includes(line)) lines.push(`    + ${line}`);
    }
  }
  return lines;
}

const update = process.argv.includes("--update");
const now = await live();
if (update) {
  writeFileSync(SNAPSHOT, `${JSON.stringify({ checkedOn: new Date().toISOString().slice(0, 10), ...now }, null, 2)}\n`);
  console.log(`Saved ${Object.keys(now.pages).length} pages to ${path.relative(process.cwd(), SNAPSHOT)}.`);
} else {
  const saved = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  const changes = compare(saved, now);
  if (changes.length === 0) {
    console.log(`The pipeline SQL reference matches the snapshot from ${saved.checkedOn} (${Object.keys(now.pages).length} pages).`);
  } else {
    console.log(`The Databricks pipeline SQL reference changed since ${saved.checkedOn}:\n\n${changes.join("\n")}\n`);
    console.log("Check src/bundle/pipelineSql.ts against the change, then save the new pages with");
    console.log("`npm run update:pipeline-sql-reference` and run its unit tests, which read Databricks' examples.");
    process.exitCode = 1;
  }
}
