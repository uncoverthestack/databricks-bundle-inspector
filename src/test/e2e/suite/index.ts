import Mocha from "mocha";
import { cliNotFoundSuite } from "./cliNotFound.test.js";

/** Entry point VS Code calls from the extension host. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", timeout: 60_000 + Number(process.env.E2E_PAUSE_MS ?? 0), color: true });
  mocha.suite.emit("pre-require", globalThis, "cliNotFound", mocha);
  cliNotFoundSuite();
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} e2e test(s) failed`)) : resolve(),
    );
  });
}
