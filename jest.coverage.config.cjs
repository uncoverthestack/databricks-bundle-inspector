// Unit tests with a coverage floor per folder. CI runs this, so a pull request that
// lowers a folder's coverage below its floor fails. Floors are the coverage on
// 2026-11-26 (#670), rounded down: when a folder's coverage rises, raise its floor to match.
// Jest checks a folder's floor against all its files together, subfolders included.
const base = require("./jest.config.cjs");

/** @type {import("jest").Config} */
module.exports = {
  ...base,
  collectCoverage: true,
  // Every source file counts, including those no test loads.
  collectCoverageFrom: ["src/**/*.ts", "!src/test/**", "!src/**/*.d.ts"],
  coverageReporters: ["text-summary", "json-summary"],
  coverageThreshold: {
    "./src/bundle/": { statements: 92, branches: 84, functions: 92, lines: 94 },
    "./src/cli/": { statements: 70, branches: 52, functions: 75, lines: 70 },
    "./src/databricksCli/": { statements: 94, branches: 91, functions: 92, lines: 94 },
    "./src/extension/": { statements: 78, branches: 76, functions: 77, lines: 79 },
    // Mostly VS Code wiring, tested end to end; #652 moves logic out of it.
    "./src/extension.ts": { statements: 4, lines: 4 },
    "./src/telemetry/": { statements: 94, branches: 89, functions: 88, lines: 96 },
    // .ts helpers only (src/webview/lib/); the .jsx screens are checked by the e2e suites, not counted here.
    "./src/webview/": { statements: 96, branches: 86, functions: 97, lines: 98 },
  },
};
