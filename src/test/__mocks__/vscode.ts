// Minimal vscode stub for unit tests. Add members as tests require them.
export const workspace = {
  getWorkspaceFolder: () => undefined,
  findFiles: async () => [],
  getConfiguration: () => ({
    get: () => undefined,
    inspect: () => undefined,
    update: async () => {},
  }),
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
};

export const Uri = {
  file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
  parse: (value: string) => ({ toString: () => value }),
  joinPath: (...args: { fsPath: string }[]) => ({
    fsPath: args.map((a) => a.fsPath).join("/"),
  }),
};

export const RelativePattern = class {
  constructor(
    public base: string,
    public pattern: string,
  ) {}
};

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export const window = {
  showErrorMessage: () => {},
  showInformationMessage: () => {},
};

export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3,
}

export const env = {
  appName: "Visual Studio Code",
  machineId: "test-machine-id",
  sessionId: "test-session-id",
  openExternal: async () => true,
  createTelemetryLogger: () => {
    throw new Error("replace env.createTelemetryLogger in the test");
  },
};
