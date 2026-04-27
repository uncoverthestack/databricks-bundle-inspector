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
  testMatch: ["<rootDir>/src/test/unit/**/*.test.ts"],
  verbose: true,
  clearMocks: true,
  setupFilesAfterEnv: ["<rootDir>/src/test/setup.ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^vscode$": "<rootDir>/src/test/__mocks__/vscode.ts",
  },
};
