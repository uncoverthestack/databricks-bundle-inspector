// Builds the live rule probes runner (#650) into out/live-rules/run.cjs. See build-e2e.mjs for
// why it uses esbuild's JavaScript API.
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/test/liveRules/run.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "out/live-rules/run.cjs",
  logLevel: "warning",
});
