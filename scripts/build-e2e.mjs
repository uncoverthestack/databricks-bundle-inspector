#!/usr/bin/env node

// Builds the e2e launcher and suite. Uses esbuild's JavaScript API, not the `esbuild`
// command: on Windows, cmd.exe (which npm runs scripts with) looks in the current
// folder before PATH, so `esbuild` there runs this repo's `esbuild.js` instead.
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/test/e2e/runTest.ts", "src/test/e2e/suite/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir: "out/e2e",
  outExtension: { ".js": ".cjs" },
  external: ["vscode", "mocha", "@vscode/test-electron"],
  logLevel: "warning",
});
