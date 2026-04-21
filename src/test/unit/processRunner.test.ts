import { jest, test, expect } from "@jest/globals";

const execFileAsyncMock = jest.fn<
  (
    candidate: string,
    args: string[],
    options: { timeout: number },
  ) => Promise<{
    stdout: string;
    stderr: string;
  }>
>();

jest.mock("node:util", () => ({
  promisify: jest.fn(() => execFileAsyncMock),
}));

import { runVersionCommand } from "../../databricksCli/processRunner";

test("runs candidate with --version and timeout", async () => {
  execFileAsyncMock.mockResolvedValue({
    stdout: "Databricks CLI v0.295.0",
    stderr: "",
  });

  const result = await runVersionCommand("databricks", 2000);

  expect(execFileAsyncMock).toHaveBeenCalledWith("databricks", ["--version"], {
    timeout: 2000,
  });

  expect(result).toEqual({
    stdout: "Databricks CLI v0.295.0",
    stderr: "",
  });
});
