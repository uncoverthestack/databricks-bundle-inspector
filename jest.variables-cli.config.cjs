/**
 * The variables fixtures through a real CLI, once (not per fixture, as the semantic
 * matrix runs its tests): against a fake local workspace, or with
 * INSPECTOR_TEST_PROFILE, a real one. See variablesCli.integration.test.ts.
 */
module.exports = {
  ...require("./jest.semantic-cli.config.cjs"),
  testMatch: [
    "<rootDir>/src/test/integration/variablesCli.integration.test.ts",
    // Variable loops (#228), each case against the CLI itself.
    "<rootDir>/src/test/integration/variableLoopsCli.integration.test.ts",
  ],
  testTimeout: 120_000,
};
