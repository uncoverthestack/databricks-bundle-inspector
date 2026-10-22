import Mocha from "mocha";
import { requireSuite } from "../options.js";
import { cliNotFoundSuite } from "./cliNotFound.test.js";
import { includeMistakesSuite } from "./includeMistakes.test.js";
import { alwaysOnSuite } from "./alwaysOn.test.js";
import { savedFileSuite } from "./savedFile.test.js";
import { targetsSuite } from "./targets.test.js";
import { issueCodesSuite } from "./issueCodes.test.js";
import { resourceFilesSuite } from "./resourceFiles.test.js";
import { graphRefreshSuite } from "./graphRefresh.test.js";
import { inspectionRacesSuite } from "./inspectionRaces.test.js";
import { themesSuite } from "./themes.test.js";

/** Entry point VS Code calls from the extension host. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", timeout: 60_000 + Number(process.env.E2E_PAUSE_MS ?? 0), color: true });
  const suite = requireSuite(process.env.E2E_SUITE ?? "cliNotFound");
  mocha.suite.emit("pre-require", globalThis, suite, mocha);
  if (suite === "includeMistakes") includeMistakesSuite();
  else if (suite === "issueCodes") issueCodesSuite();
  else if (suite === "resourceFiles") resourceFilesSuite();
  else if (suite === "graphRefresh") graphRefreshSuite();
  else if (suite === "inspectionRaces") inspectionRacesSuite();
  else if (suite === "alwaysOn") alwaysOnSuite();
  else if (suite === "savedFile") savedFileSuite();
  else if (suite === "targets") targetsSuite();
  else if (suite === "themes") themesSuite();
  else cliNotFoundSuite();
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} e2e test(s) failed`)) : resolve(),
    );
  });
}
