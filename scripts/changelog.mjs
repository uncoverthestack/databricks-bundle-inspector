#!/usr/bin/env node

// The CHANGELOG's unreleased entries, one file per change in changes/, so two pull requests
// never edit the same lines (13 of the 15 merge conflicts between 2026-10-01 and 2026-10-28
// were in CHANGELOG.md). See changes/README.md for the file format.
//
//   node scripts/changelog.mjs check     every file in changes/ is well formed
//   node scripts/changelog.mjs preview   print what release would add
//   node scripts/changelog.mjs release   move every file into [Unreleased], then delete them
//   node scripts/changelog.mjs notes 0.6.0   print that version's section, for its GitHub release
//
// --root <folder> runs it on another copy of the repo (the tests use it).
import { readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Keep a Changelog's sections, in the order they appear under a version. */
export const SECTIONS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

/**
 * One change file: its first line is the section (`Fixed` or `### Fixed`), the rest is the
 * entry as it reads in the CHANGELOG, one or more `- ` items.
 */
export function parseChange(text, name) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim());
  const section = first === -1 ? "" : lines[first].trim().replace(/^###\s+/, "");
  if (!SECTIONS.includes(section)) {
    throw new Error(`${name}: the first line must be one of ${SECTIONS.join(", ")}, not "${section}"`);
  }
  const body = lines.slice(first + 1).join("\n").trim();
  if (!body.split("\n").some((line) => line.startsWith("- "))) {
    throw new Error(`${name}: needs an entry starting with "- " after the ${section} line`);
  }
  return { section, body };
}

/** Every change file, newest first: higher issue numbers first, as entries are listed now. */
export function readChanges(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
    .map((name) => ({ name, ...parseChange(readFileSync(path.join(dir, name), "utf8"), name) }));
}

/**
 * The CHANGELOG with each change at the top of its section under [Unreleased], in the line
 * endings it has: git on Windows checks it out with CRLF, and a rewrite to LF would change
 * every line.
 */
export function withChanges(changelog, changes) {
  const eol = changelog.includes("\r\n") ? "\r\n" : "\n";
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.startsWith("## [Unreleased]"));
  if (start === -1) throw new Error("CHANGELOG.md has no ## [Unreleased] heading");
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
  const end = next === -1 ? lines.length : next;
  const block = lines.slice(start + 1, end);

  for (const section of SECTIONS) {
    const bodies = changes.filter((change) => change.section === section).map((change) => change.body);
    if (bodies.length === 0) continue;
    const entries = bodies.join("\n").split("\n");
    const heading = block.findIndex((line) => line.trim() === `### ${section}`);
    if (heading !== -1) {
      // Under the heading and its blank line, above the entries already there.
      block.splice(heading + 2, 0, ...entries);
      continue;
    }
    // A missing section goes before the first later one, as Keep a Changelog orders them.
    const later = block.findIndex((line) => SECTIONS.slice(SECTIONS.indexOf(section) + 1).some((s) => line.trim() === `### ${s}`));
    const at = later === -1 ? block.length : later;
    block.splice(at, 0, ...(at > 0 && block[at - 1].trim() ? [""] : []), `### ${section}`, "", ...entries, "");
  }
  // One blank line before the next version.
  while (block.length > 1 && !block[block.length - 1].trim() && !block[block.length - 2].trim()) block.pop();
  if (next !== -1 && block.at(-1)?.trim()) block.push("");
  return [...lines.slice(0, start + 1), ...block, ...lines.slice(end)].join(eol);
}

/**
 * One version's section of the CHANGELOG, without its heading: what its GitHub release page
 * shows. It ends at the next version's heading or at the compare links at the bottom. Throws
 * when the version has no heading or nothing under it, so a release never gets empty notes.
 */
export function releaseNotes(changelog, version) {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const heading = `## [${version}]`;
  const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} `));
  if (start === -1) throw new Error(`CHANGELOG.md has no ${heading} heading`);
  const next = lines.findIndex((line, index) => index > start && (line.startsWith("## [") || /^\[[^\]]+\]: /.test(line)));
  const notes = lines.slice(start + 1, next === -1 ? lines.length : next).join("\n").trim();
  if (!notes) throw new Error(`CHANGELOG.md has nothing under ${heading}`);
  return notes;
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const rootAt = args.indexOf("--root");
  const root = path.resolve(rootAt === -1 ? process.cwd() : args[rootAt + 1]);
  const dir = path.join(root, "changes");
  const file = path.join(root, "CHANGELOG.md");
  if (command === "notes") {
    const version = args[1];
    if (!version || version.startsWith("--")) {
      console.error("Usage: node scripts/changelog.mjs notes <version> [--root <folder>]");
      process.exit(2);
    }
    try {
      console.log(releaseNotes(readFileSync(file, "utf8"), version));
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    return;
  }
  if (!["check", "preview", "release"].includes(command)) {
    console.error("Usage: node scripts/changelog.mjs check|preview|release|notes [--root <folder>]");
    process.exit(2);
  }
  let changes;
  try {
    changes = readChanges(dir);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (command === "check") {
    console.log(`${changes.length} change file${changes.length === 1 ? "" : "s"} in changes/, all well formed.`);
    return;
  }
  let updated;
  try {
    updated = withChanges(readFileSync(file, "utf8"), changes);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (command === "preview") {
    for (const section of SECTIONS) {
      const bodies = changes.filter((change) => change.section === section);
      if (bodies.length) console.log(`### ${section}\n\n${bodies.map((change) => change.body).join("\n")}\n`);
    }
    return;
  }
  writeFileSync(file, updated);
  for (const change of changes) rmSync(path.join(dir, change.name));
  console.log(`Moved ${changes.length} change file${changes.length === 1 ? "" : "s"} into CHANGELOG.md [Unreleased].`);
}

// Run, not imported. Both paths resolved, as a folder reached through a link (macOS's /var
// is /private/var) would otherwise not match, and the script would silently do nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
