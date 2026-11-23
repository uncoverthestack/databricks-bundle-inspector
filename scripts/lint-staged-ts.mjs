// Commit hook step: lint the staged .ts files with ESLint, with the same zero-warning rule as
// `npm run lint` in CI. Replaces lint-staged, which brought 24 packages for this one job
// (#492).
//
// It checks and never fixes. A fix would have to be staged again, and staging a whole file
// would also commit any changes in it you had left unstaged. Run `npx eslint --fix <file>`
// yourself, then stage what you want.
//
// ESLint lints the file as it is on disk, so a partly staged file is checked with its
// unstaged changes too. CI lints the committed tree either way.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const listed = spawnSync(
  "git",
  ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
  { encoding: "utf8" },
);
if (listed.status !== 0) {
  process.stderr.write(listed.stderr || "git diff --cached failed\n");
  process.exit(1);
}

const files = listed.stdout.split("\0").filter((file) => file.endsWith(".ts"));
if (files.length === 0) {
  process.exit(0);
}

// Run ESLint's own entry file with this Node, not through a shell or npx, so no other
// `eslint` on PATH or in the folder can be picked instead.
const eslint = path.join("node_modules", "eslint", "bin", "eslint.js");
if (!existsSync(eslint)) {
  process.stderr.write("ESLint is not installed. Run npm ci first.\n");
  process.exit(1);
}

// Batches keep the command line under Windows' length limit.
const batchSize = 100;
let failed = false;
for (let start = 0; start < files.length; start += batchSize) {
  const batch = files.slice(start, start + batchSize);
  const run = spawnSync(
    process.execPath,
    [eslint, "--max-warnings", "0", "--no-warn-ignored", "--", ...batch],
    { stdio: "inherit" },
  );
  if (run.status !== 0) {
    failed = true;
  }
}

if (failed) {
  process.stderr.write(
    "\nESLint found problems in staged files. Fix them (npx eslint --fix <file> fixes many), stage the fix, and commit again.\n",
  );
  process.exit(1);
}
