// Fetches the real bundles in src/test/corpus/corpus.json at their pinned commits (#651), into
// the folder given, and prints each folder to compare, one per line. Only the commit is fetched,
// and only the paths listed when there are any.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const out = path.resolve(process.argv[2] ?? "corpus");
const corpus = JSON.parse(readFileSync(path.join(import.meta.dirname, "../src/test/corpus/corpus.json"), "utf8"));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "inherit"] });

for (const repo of corpus.repositories) {
  const dir = path.join(out, repo.folder);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", repo.url);
  if (repo.paths.length > 0) git(dir, "sparse-checkout", "set", "--no-cone", ...repo.paths.map((p) => `/${p}/`));
  git(dir, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", repo.commit);
  git(dir, "checkout", "-q", "FETCH_HEAD");
  for (const sub of repo.paths.length > 0 ? repo.paths : ["."]) console.log(path.join(dir, sub));
}
