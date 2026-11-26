// Builds the corpus comparison (#651) into out/corpus/run.cjs. See build-e2e.mjs for why it
// uses esbuild's JavaScript API.
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/test/corpus/run.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "out/corpus/run.cjs",
  logLevel: "warning",
});
