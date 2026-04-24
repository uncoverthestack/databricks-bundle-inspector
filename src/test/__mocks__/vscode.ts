// Minimal vscode stub for unit tests. Add members as tests require them.
export const workspace = {
  getWorkspaceFolder: () => undefined,
  findFiles: async () => [],
  getConfiguration: () => ({
    get: () => undefined,
    inspect: () => undefined,
    update: async () => {},
  }),
};

export const Uri = {
  file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
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
