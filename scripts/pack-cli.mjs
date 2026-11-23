// Builds the command-line tool once and packs it under both of its npm names (#348), so the two
// packages hold the same bytes and differ only in their name.
//
//   node scripts/pack-cli.mjs --out <folder>                    the version in cli/package.json
//   node scripts/pack-cli.mjs --out <folder> --version 1.2.3-next.0   a pre-release
//
// Prints one line per package file written, and checks each one reports its own version.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

export const NPM_NAMES = ["@uncoverthestack/databricks-bundle-inspector", "databricks-bundle-inspector"];
const PACKED_FILES = ["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "dist/cli.cjs"];

const root = path.resolve(import.meta.dirname, "..");
const cliDir = path.join(root, "cli");
const { values: args } = parseArgs({ options: { out: { type: "string" }, version: { type: "string" } } });
if (!args.out) throw new Error("Usage: node scripts/pack-cli.mjs --out <folder> [--version <x.y.z-pre.n>]");
const out = path.resolve(args.out);
mkdirSync(out, { recursive: true });

execFileSync(process.execPath, [path.join(root, "scripts/build-cli.mjs"), ...(args.version ? ["--version", args.version] : [])], {
  stdio: "inherit",
});
const pkg = JSON.parse(readFileSync(path.join(cliDir, "package.json"), "utf8"));
const version = args.version ?? pkg.version;

// npm itself, without a shell: npm_execpath is set under `npm run`; Windows can't spawn npm.cmd without one.
function npm(npmArgs, cwd) {
  const execPath = process.env.npm_execpath;
  if (execPath && /\.c?js$/.test(execPath)) {
    return execFileSync(process.execPath, [execPath, ...npmArgs], { cwd, encoding: "utf8" });
  }
  if (process.platform === "win32") throw new Error("On Windows, run this as npm run pack:cli -- --out <folder>");
  return execFileSync("npm", npmArgs, { cwd, encoding: "utf8" });
}

const stage = mkdtempSync(path.join(tmpdir(), "inspector-cli-pack-"));
try {
  for (const name of NPM_NAMES) {
    const dir = path.join(stage, name.replace(/[@/]/g, "_"));
    for (const file of PACKED_FILES) cpSync(path.join(cliDir, file), path.join(dir, file));
    writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ ...pkg, name, version }, null, 2)}\n`);

    const reported = execFileSync(process.execPath, [path.join(dir, "dist/cli.cjs"), "--version"], { encoding: "utf8" }).trim();
    if (reported !== version) throw new Error(`${name}: the built tool reports ${reported}, not ${version}`);

    const [packed] = JSON.parse(npm(["pack", dir, "--pack-destination", out, "--ignore-scripts", "--json"], stage));
    if (packed.name !== name || packed.version !== version) {
      throw new Error(`Packed ${packed.name}@${packed.version}, expected ${name}@${version}`);
    }
    const files = packed.files.map((file) => file.path).sort();
    if (files.join() !== [...PACKED_FILES].sort().join()) throw new Error(`${name} packed unexpected files: ${files.join(", ")}`);
    console.log(path.join(out, packed.filename));
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
