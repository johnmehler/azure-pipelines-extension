"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");
const pkg = require("../package.json");

function createExtensionHarness({
  configValues = {},
  secrets = {},
  inputResponses = [],
  quickPickResponses = [],
  warningResponses = [],
  fetchImpl
} = {}) {
  const commands = new Map();
  const treeProviders = new Map();
  const openedExternal = [];
  const infoMessages = [];
  const warningMessages = [];
  const errorMessages = [];
  const secretMap = new Map(Object.entries(secrets));

  class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }
  class ThemeIcon {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  }
  class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  }
  class EventEmitter {
    constructor() {
      this.listeners = [];
      this.event = listener => {
        this.listeners.push(listener);
        return {dispose() {}};
      };
    }

    fire(value) {
      this.listeners.forEach(listener => listener(value));
    }

    dispose() {}
  }

  const vscode = {
    TreeItem,
    ThemeIcon,
    ThemeColor,
    EventEmitter,
    TreeItemCollapsibleState: {None: 0, Collapsed: 1},
    ConfigurationTarget: {Global: 1, Workspace: 2, WorkspaceFolder: 3},
    StatusBarAlignment: {Left: 1, Right: 2},
    DiagnosticSeverity: {Error: 0, Warning: 1},
    Uri: {
      parse: value => ({toString: () => value, fsPath: value}),
      file: value => ({toString: () => `file://${value}`, fsPath: value}),
      joinPath: (base, ...parts) => ({toString: () => `${base.toString()}/${parts.join("/")}`, fsPath: `${base.fsPath}/${parts.join("/")}`}),
      from: parts => ({...parts, toString: () => `${parts.scheme}://${parts.path}?${parts.query}`})
    },
    env: {
      openExternal: async uri => {
        openedExternal.push(uri.toString());
        return true;
      },
      clipboard: {writeText: async () => {}}
    },
    extensions: {
      getExtension: () => undefined
    },
    authentication: {
      getSession: async () => undefined
    },
    languages: {
      createDiagnosticCollection: () => ({
        set() {},
        delete() {},
        dispose() {}
      }),
      registerCompletionItemProvider: () => ({dispose() {}}),
      registerHoverProvider: () => ({dispose() {}}),
      registerDefinitionProvider: () => ({dispose() {}}),
      registerInlayHintsProvider: () => ({dispose() {}})
    },
    workspace: {
      workspaceFolders: [],
      textDocuments: [],
      registerTextDocumentContentProvider: () => ({dispose() {}}),
      onDidChangeWorkspaceFolders: () => ({dispose() {}}),
      onDidOpenTextDocument: () => ({dispose() {}}),
      onDidChangeTextDocument: () => ({dispose() {}}),
      onDidSaveTextDocument: () => ({dispose() {}}),
      onDidCloseTextDocument: () => ({dispose() {}}),
      onDidChangeConfiguration: () => ({dispose() {}}),
      getWorkspaceFolder: () => undefined,
      getConfiguration: () => ({
        get: (key, fallback) => (Object.hasOwn(configValues, key) ? configValues[key] : fallback),
        update: async (key, value) => {
          configValues[key] = value;
        }
      })
    },
    window: {
      activeTextEditor: undefined,
      registerTreeDataProvider: (id, provider) => {
        treeProviders.set(id, provider);
        return {dispose() {}};
      },
      createStatusBarItem: () => ({
        show() {},
        hide() {},
        dispose() {}
      }),
      onDidChangeActiveTextEditor: () => ({dispose() {}}),
      showInputBox: async () => inputResponses.shift(),
      showQuickPick: async () => quickPickResponses.shift(),
      showWarningMessage: async (message) => {
        warningMessages.push(message);
        return warningResponses.shift();
      },
      showInformationMessage: async (message) => {
        infoMessages.push(message);
      },
      showErrorMessage: async (message) => {
        errorMessages.push(message);
      }
    },
    commands: {
      registerCommand: (name, handler) => {
        commands.set(name, handler);
        return {dispose() {}};
      }
    }
  };

  const originalFetch = globalThis.fetch;
  if (fetchImpl) {
    globalThis.fetch = fetchImpl;
  }

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  let extension;
  try {
    delete require.cache[require.resolve("../src/extension")];
    extension = require("../src/extension");
  } finally {
    Module._load = originalLoad;
  }

  const context = {
    subscriptions: [],
    secrets: {
      get: async key => secretMap.get(key),
      store: async (key, value) => secretMap.set(key, value),
      delete: async key => secretMap.delete(key)
    },
    workspaceState: {
      get: (_key, fallback) => fallback,
      update: async () => {}
    }
  };
  extension.activate(context);

  return {
    commands,
    treeProviders,
    openedExternal,
    infoMessages,
    warningMessages,
    errorMessages,
    cleanup() {
      for (const item of context.subscriptions) {
        item?.dispose?.();
      }
      if (fetchImpl) {
        globalThis.fetch = originalFetch;
      }
    }
  };
}

test("activate registers all package.json commands without runtime errors", () => {
  const harness = createExtensionHarness();
  try {
    for (const entry of pkg.contributes.commands) {
      assert.equal(
        harness.commands.has(entry.command),
        true,
        `Missing command handler for ${entry.command}`
      );
    }
    assert.equal(harness.treeProviders.has("azure-pipelines.pipelines"), true);
    assert.equal(harness.treeProviders.has("azure-pipelines.currentBranch"), true);
    assert.equal(harness.treeProviders.has("azure-pipelines.settings"), true);
  } finally {
    harness.cleanup();
  }
});

test("retryStage forces all jobs while retryJob retries only failed jobs", async () => {
  const requests = [];
  const harness = createExtensionHarness({
    configValues: {organization: "contoso", project: "Platform", authMethod: "pat"},
    secrets: {"azure-pipelines.personalAccessToken": "pat-token"},
    warningResponses: ["Retry", "Retry"],
    fetchImpl: async (url, options = {}) => {
      requests.push({url: String(url), method: options.method, body: JSON.parse(options.body)});
      return {ok: true, status: 200, text: async () => "{}"};
    }
  });
  try {
    const arg = {run: {id: 12, state: "completed"}, stageRefName: "Deploy"};
    await harness.commands.get("azure-pipelines.retryStage")(arg);
    await harness.commands.get("azure-pipelines.retryJob")(arg);

    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.forceRetryAllJobs, true);
    assert.equal(requests[1].body.forceRetryAllJobs, false);
  } finally {
    harness.cleanup();
  }
});

test("updateVariable preserves masked secrets when submitted empty and addVariable trims names", async () => {
  const putPayloads = [];
  const harness = createExtensionHarness({
    configValues: {organization: "contoso", project: "Platform", authMethod: "pat"},
    secrets: {"azure-pipelines.personalAccessToken": "pat-token"},
    inputResponses: ["", "  MyVar  ", "val1"],
    quickPickResponses: ["Plain text"],
    fetchImpl: async (url, options = {}) => {
      if (options.method === "PUT") {
        putPayloads.push(JSON.parse(options.body));
        return {ok: true, status: 200, text: async () => "{}"};
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id: 5,
          name: "Shared",
          type: "Vsts",
          variables: {
            SECRET_ONE: {isSecret: true, value: null}
          }
        })
      };
    }
  });
  try {
    await harness.commands.get("azure-pipelines.updateVariable")({
      group: {id: 5, name: "Shared"},
      variableName: "SECRET_ONE",
      variable: {isSecret: true}
    });
    assert.equal(putPayloads.length, 0);

    await harness.commands.get("azure-pipelines.addVariable")({
      group: {id: 5, name: "Shared"}
    });
    assert.equal(putPayloads.length, 0, "Should prompt for masked secret confirmation when warning is cancelled");
  } finally {
    harness.cleanup();
  }
});

test("openRun does not open external URLs when connection is unconfigured", async () => {
  const harness = createExtensionHarness();
  try {
    await harness.commands.get("azure-pipelines.openRun")({run: {id: 42}});
    assert.equal(harness.openedExternal.length, 0);
  } finally {
    harness.cleanup();
  }
});
