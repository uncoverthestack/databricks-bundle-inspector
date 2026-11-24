/**
 * The weekly runtime dates check (#485): the shipped Databricks Runtime table against the
 * docs pages. Reads the network, so it runs on its own schedule, not with the unit tests.
 */
module.exports = {
  ...require("./jest.semantic-cli.config.cjs"),
  testMatch: ["<rootDir>/src/test/integration/runtimeDates.integration.test.ts"],
};
