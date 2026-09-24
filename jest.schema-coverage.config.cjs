const semanticCliConfig = require("./jest.semantic-cli.config.cjs");

/** @type {import("jest").Config} */
module.exports = {
  ...semanticCliConfig,
  testMatch: ["<rootDir>/src/test/integration/schemaCoverage.integration.test.ts"],
};
