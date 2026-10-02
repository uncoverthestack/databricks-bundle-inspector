import Mocha from "mocha";
import { cliNotFoundSuite } from "./cliNotFound.test.js";
import { includeMistakesSuite } from "./includeMistakes.test.js";

/** Entry point VS Code calls from the extension host. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", timeout: 60_000 + Number(process.env.E2E_PAUSE_MS ?? 0), color: true });
  const suite = process.env.E2E_SUITE ?? "cliNotFound";
  mocha.suite.emit("pre-require", globalThis, suite, mocha);
  if (suite === "includeMistakes") includeMistakesSuite();
  else cliNotFoundSuite();
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} e2e test(s) failed`)) : resolve(),
    );
  });
}
