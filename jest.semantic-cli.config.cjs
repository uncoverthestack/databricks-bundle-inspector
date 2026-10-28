const { createDefaultPreset } = require("ts-jest");

const tsJestPreset = createDefaultPreset();

/** @type {import("jest").Config} */
module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.jest.json",
      },
    ],
  },
  testMatch: [
    "<rootDir>/src/test/integration/semanticCli.integration.test.ts",
    "<rootDir>/src/test/integration/bundleCodeNotRun.integration.test.ts",
    "<rootDir>/src/test/integration/bundleFolderUntouched.integration.test.ts",
    "<rootDir>/src/test/integration/realTargetPaths.integration.test.ts",
    "<rootDir>/src/test/integration/realTargetFallback.integration.test.ts",
    "<rootDir>/src/test/integration/verifyCliPath.integration.test.ts",
    "<rootDir>/src/test/integration/quickFix.integration.test.ts",
    "<rootDir>/src/test/integration/pathSuggestion.integration.test.ts",
    "<rootDir>/src/test/integration/pathNotChecked.integration.test.ts",
    "<rootDir>/src/test/integration/pipelineView.integration.test.ts",
    "<rootDir>/src/test/integration/variableFields.integration.test.ts",
  ],
  modulePathIgnorePatterns: ["<rootDir>/.vscode-test/", "<rootDir>/out/"],
  verbose: true,
  clearMocks: true,
  setupFilesAfterEnv: ["<rootDir>/src/test/setup.ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^vscode$": "<rootDir>/src/test/__mocks__/vscode.ts",
  },
  testTimeout: 45_000,
};
