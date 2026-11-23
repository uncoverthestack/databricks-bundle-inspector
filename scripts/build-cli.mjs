// Builds the command-line tool (#348) into cli/: one file with no runtime dependencies, plus the
// licences of the libraries bundled into it. Kept apart from esbuild.js so the VSIX is unchanged.
import * as esbuild from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cliDir = path.join(root, "cli");
const pkg = JSON.parse(readFileSync(path.join(cliDir, "package.json"), "utf8"));

const result = await esbuild.build({
  entryPoints: [path.join(root, "src/cli/bin.ts")],
  outfile: path.join(cliDir, "dist/cli.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  // Readable on purpose, so anyone can audit what they run.
  minify: false,
  sourcemap: false,
  legalComments: "eof",
  banner: { js: "#!/usr/bin/env node" },
  define: { __CLI_VERSION__: JSON.stringify(pkg.version) },
  metafile: true,
  logLevel: "warning",
});

// Every npm package bundled in, with its licence text, as their licences ask.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (!match) continue;
  const dir = path.join(root, input.slice(0, match.index + match[0].length));
  if (packages.has(dir)) continue;
  const meta = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const licenceFile = readdirSync(dir).find((name) => /^(licen[cs]e|copying)([.\-_]|$)/i.test(name));
  packages.set(dir, {
    name: meta.name,
    version: meta.version,
    license: meta.license ?? "UNKNOWN",
    text: licenceFile ? readFileSync(path.join(dir, licenceFile), "utf8").trim() : undefined,
  });
}
const notices = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
const missing = notices.filter((entry) => !entry.text).map((entry) => entry.name);
if (missing.length > 0) throw new Error(`No licence file found for: ${missing.join(", ")}`);
writeFileSync(
  path.join(cliDir, "THIRD_PARTY_NOTICES.md"),
  [
    "# Third-party notices",
    "",
    "`dist/cli.cjs` includes these packages.",
    ...notices.flatMap((entry) => ["", `## ${entry.name} ${entry.version} (${entry.license})`, "", "```", entry.text, "```"]),
    "",
  ].join("\n"),
);

if (!existsSync(cliDir)) mkdirSync(cliDir);
copyFileSync(path.join(root, "LICENSE"), path.join(cliDir, "LICENSE"));
console.log(`cli/dist/cli.cjs ${pkg.version}: ${notices.length} bundled packages (${notices.map((entry) => entry.name).join(", ")})`);
