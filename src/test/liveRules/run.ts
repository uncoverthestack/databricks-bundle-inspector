/**
 * Deploys and runs each live rule probe on a real workspace and compares what happens with what
 * the rule says (#650). Local only: it needs a sign-in, so it never runs in GitHub Actions.
 *
 *   npm run live-rules -- --profile <profile> [--cli <databricks>] [--runs 2] [--probe <id>]...
 *
 * Each variant runs `--runs` times, under a new bundle name each time. Everything a run makes
 * is removed after it: `bundle destroy`, then its `.bundle/<name>` folder, then checked gone.
 * Exits 1 when a confirmed step differs or something couldn't be removed.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { judge, loadProbes, probeProblems, STEPS, type StepResult } from "./probes.js";

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    cli: { type: "string", default: "databricks" },
    runs: { type: "string", default: "2" },
    probe: { type: "string", multiple: true },
    probes: { type: "string", default: path.resolve(__dirname, "../../src/test/liveRules/probes") },
  },
});
if (!values.profile) throw new Error("--profile is required: the probes deploy to that workspace.");
const profile = values.profile;
const runs = Number(values.runs);

/** A step's whole run can take a while: a serverless job starts in a few minutes. */
const STEP_TIMEOUT_MS = 30 * 60 * 1000;

function cli(args: string[], cwd?: string): { ok: boolean; output: string } {
  const result = spawnSync(values.cli!, [...args, "-p", profile], { cwd, encoding: "utf8", timeout: STEP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}` };
}

const STEP_ARGS: Record<(typeof STEPS)[number], string[]> = {
  validate: ["bundle", "validate", "-t", "probe"],
  deploy: ["bundle", "deploy", "-t", "probe", "--auto-approve"],
  run: ["bundle", "run", "probe", "-t", "probe"],
};

function textFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? textFiles(file) : /\.(ya?ml|py|sql|toml|json)$/.test(name) ? [file] : [];
  });
}

const me = cli(["current-user", "me", "-o", "json"]);
if (!me.ok) throw new Error(`Can't sign in with profile ${profile}:\n${me.output}`);
const user = (JSON.parse(me.output.slice(me.output.indexOf("{"))) as { userName: string }).userName;
const cliVersion = spawnSync(values.cli!, ["--version"], { encoding: "utf8" }).stdout.trim();

const probes = loadProbes(values.probes!).filter((probe) => !values.probe || values.probe.includes(probe.id));
const problems = probes.flatMap(probeProblems);
if (problems.length > 0) throw new Error(`Probe files are wrong:\n${problems.join("\n")}`);

let differs = 0;
const leftovers: string[] = [];
console.log(`${cliVersion}, profile ${profile}, ${probes.length} probes, ${runs} runs each\n`);
for (const probe of probes) {
  for (const [variant, expected] of Object.entries(probe.variants)) {
    for (let run = 1; run <= runs; run++) {
      const name = `dbi-probe-${probe.id}-${variant}-${run}-${Math.random().toString(36).slice(2, 8)}`.replace(/_/g, "-").toLowerCase();
      const dir = mkdtempSync(path.join(tmpdir(), "dbi-probe-"));
      cpSync(path.join(probe.folder, variant), dir, { recursive: true });
      for (const file of textFiles(dir)) writeFileSync(file, readFileSync(file, "utf8").replaceAll("__NAME__", name));
      const results: StepResult[] = [];
      try {
        for (const step of STEPS) {
          if (expected[step] === undefined) break;
          const { ok, output } = cli(STEP_ARGS[step], dir);
          results.push({ step, outcome: ok ? "pass" : "fail", output });
          if (!ok) break;
        }
      } finally {
        // Destroy even after a failed deploy, which can leave part of it behind.
        if (results.some((result) => result.step === "deploy")) cli(["bundle", "destroy", "-t", "probe", "--auto-approve"], dir);
        // A validate with a sign-in makes the target's empty files folder too.
        const folder = `/Workspace/Users/${user}/.bundle/${name}`;
        cli(["workspace", "delete", folder, "--recursive"]);
        if (cli(["workspace", "get-status", folder]).ok) leftovers.push(folder);
        rmSync(dir, { recursive: true, force: true });
      }
      const verdict = judge(expected, results);
      if (!verdict.matches) differs++;
      console.log(`${verdict.matches ? "ok     " : "DIFFERS"} ${probe.id} ${variant} run ${run}: first failure ${verdict.firstFailure}`);
      for (const line of verdict.lines) console.log(`          ${line}`);
      if (!verdict.matches) {
        const failed = results.find((result) => result.outcome === "fail") ?? results.at(-1);
        if (failed) console.log(`          ${failed.step} said: ${failed.output.trim().split("\n").slice(-3).join(" / ").slice(0, 400)}`);
      }
    }
  }
}
console.log(`\n${differs} differing, ${leftovers.length} not removed${leftovers.length ? `: ${leftovers.join(", ")}` : ""}`);
if (differs > 0 || leftovers.length > 0) process.exitCode = 1;
