"use strict";

const {execFile} = require("child_process");
const {promisify} = require("util");
const vscode = require("vscode");
const {AzureDevOpsApi} = require("./api");
const {normalizeVariables, parseJsonObject, webLogUrl, webRunUrl} = require("./helpers");
const {LibraryProvider, PipelineProvider, responseItems} = require("./providers");
const {
  getExpressionCompletions,
  getExpressionDiagnostics,
  getExpressionHover,
  getParameterDefinitions,
  isAzurePipelineDocument,
  parameterPromptKind,
  typedParameterValue
} = require("./yamlSupport");

const execFileAsync = promisify(execFile);
const PAT_SECRET_KEY = "azure-pipelines.personalAccessToken";
const AZURE_DEVOPS_SCOPES = [
  "499b84ac-1321-427f-aa17-267ca6975798/.default",
  "offline_access"
];

function getPipelineArgument(argument) {
  return argument?.pipeline || argument;
}

function getRunArgument(argument) {
  return argument?.run;
}

async function currentGitBranch() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  try {
    const {stdout} = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: folder.uri.fsPath,
      windowsHide: true,
      timeout: 3000
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function activate(context) {
  const secretStorage = context.secrets;
  const getConnectionValues = async () => {
    const settings = vscode.workspace.getConfiguration("azure-pipelines");
    const authMethod = settings.get("authMethod", "pat");
    let token;
    if (authMethod === "microsoft") {
      try {
        const session = await vscode.authentication.getSession(
          "microsoft",
          AZURE_DEVOPS_SCOPES,
          {createIfNone: false}
        );
        token = session?.accessToken;
      } catch {
        token = undefined;
      }
    } else {
      token = await secretStorage.get(PAT_SECRET_KEY);
    }
    return {
      organization: settings.get("organization", "").trim(),
      project: settings.get("project", "").trim(),
      token,
      authMethod,
      authType: authMethod === "microsoft" ? "bearer" : "pat"
    };
  };

  let configuring;
  const configureConnection = async () => {
    if (configuring) {
      return configuring;
    }
    configuring = (async () => {
      const values = await getConnectionValues();
      const organization = await vscode.window.showInputBox({
        title: "Azure DevOps connection",
        prompt: "Organization name from https://dev.azure.com/{organization}",
        value: values.organization,
        ignoreFocusOut: true
      });
      if (!organization?.trim()) {
        return false;
      }
      const project = await vscode.window.showInputBox({
        title: "Azure DevOps connection",
        prompt: "Project name or ID",
        value: values.project,
        ignoreFocusOut: true
      });
      if (!project?.trim()) {
        return false;
      }
      const selectedAuth = await vscode.window.showQuickPick([
        {label: "Microsoft account sign-in", description: "Recommended; token is managed by VS Code", value: "microsoft"},
        {label: "Personal access token", description: "Stored in VS Code SecretStorage", value: "pat"}
      ], {placeHolder: "Choose Azure DevOps authentication"});
      if (!selectedAuth) {
        return false;
      }
      let token;
      if (selectedAuth.value === "microsoft") {
        try {
          const session = await vscode.authentication.getSession(
            "microsoft",
            AZURE_DEVOPS_SCOPES,
            {createIfNone: true}
          );
          token = session?.accessToken;
        } catch (error) {
          void vscode.window.showErrorMessage(`Microsoft sign-in failed: ${error.message}`);
          return false;
        }
        if (!token) {
          return false;
        }
      } else {
        const savedPat = await secretStorage.get(PAT_SECRET_KEY);
        const enteredPat = await vscode.window.showInputBox({
          title: "Azure DevOps connection",
          prompt: "Personal access token (stored in VS Code SecretStorage)",
          value: "",
          password: true,
          ignoreFocusOut: true
        });
        if (enteredPat === undefined || (!enteredPat.trim() && !savedPat)) {
          return false;
        }
        token = enteredPat.trim() || savedPat;
      }

      const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      const settings = vscode.workspace.getConfiguration("azure-pipelines");
      await settings.update("organization", organization.trim(), target);
      await settings.update("project", project.trim(), target);
      await settings.update("authMethod", selectedAuth.value, target);
      if (selectedAuth.value === "pat") {
        await secretStorage.store(PAT_SECRET_KEY, token);
      }
      await vscode.window.showInformationMessage(
        `Azure DevOps connection saved using ${selectedAuth.label}.`
      );
      refreshAll();
      return true;
    })();
    try {
      return await configuring;
    } finally {
      configuring = undefined;
    }
  };

  const getApi = async (promptForSetup = false) => {
    let values = await getConnectionValues();
    if ((!values.organization || !values.project || !values.token) && promptForSetup) {
      const answer = await vscode.window.showWarningMessage(
        "Configure an Azure DevOps organization, project, and authentication method to use pipeline features.",
        "Configure"
      );
      if (answer === "Configure") {
        await configureConnection();
        values = await getConnectionValues();
      }
    }
    if (!values.organization || !values.project || !values.token) {
      return undefined;
    }
    return new AzureDevOpsApi(values);
  };

  const selectPipeline = async api => {
    const response = await api.listPipelines();
    const pipelines = responseItems(response, "pipelines");
    const selected = await vscode.window.showQuickPick(pipelines.map(pipeline => ({
      label: pipeline.name,
      description: pipeline.folder || `Pipeline ${pipeline.id}`,
      pipeline
    })), {placeHolder: "Select an Azure Pipeline"});
    return selected?.pipeline;
  };

  const findPipelineYaml = async (api, pipeline) => {
    const details = await api.getPipeline(pipeline.id);
    const configuredPath = details.configuration?.path?.replace(/^[/\\]+/, "");
    const folders = vscode.workspace.workspaceFolders || [];
    let matches = [];
    if (configuredPath) {
      for (const folder of folders) {
        matches.push(...await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, configuredPath.replace(/\\/g, "/")),
          "**/node_modules/**",
          10
        ));
      }
    }
    if (!matches.length) {
      matches = await vscode.workspace.findFiles("**/*.{yml,yaml}", "**/node_modules/**", 500);
    }
    if (!matches.length) {
      return {details, uri: undefined};
    }
    if (matches.length === 1) {
      return {details, uri: matches[0]};
    }
    const selected = await vscode.window.showQuickPick(matches.map(uri => ({
      label: vscode.workspace.asRelativePath(uri),
      uri
    })), {placeHolder: `Choose YAML for ${pipeline.name}`});
    return {details, uri: selected?.uri};
  };

  const promptPipelineParameters = async (definitions, sourceLabel) => {
    const values = {};
    for (const parameter of definitions) {
      const name = String(parameter.name);
      const kind = parameterPromptKind(parameter);
      let selected;
      if (kind === "choice") {
        const choices = parameter.values.map(value => ({
          label: String(value),
          description: parameter.default === value ? "Default" : undefined,
          value
        }));
        selected = await vscode.window.showQuickPick(choices, {
          title: `Pipeline parameter: ${parameter.displayName || name}`,
          placeHolder: sourceLabel
        });
        if (!selected) {
          return undefined;
        }
        values[name] = selected.value;
        continue;
      }
      if (kind === "boolean") {
        const choices = [
          {label: "true", value: true},
          {label: "false", value: false}
        ];
        selected = await vscode.window.showQuickPick(choices, {
          title: `Pipeline parameter: ${parameter.displayName || name}`,
          placeHolder: sourceLabel,
          matchOnDescription: true
        });
        if (!selected) {
          return undefined;
        }
        values[name] = selected.value;
        continue;
      }
      const defaultValue = parameter.default === undefined
        ? ""
        : (typeof parameter.default === "object"
            ? JSON.stringify(parameter.default)
            : String(parameter.default));
      const raw = await vscode.window.showInputBox({
        title: `Pipeline parameter: ${parameter.displayName || name}`,
        prompt: `${name} (${parameter.type || "string"})`,
        value: defaultValue,
        ignoreFocusOut: true,
        validateInput: value => parameter.default === undefined && !value.trim()
          ? "A value is required for this parameter."
          : null
      });
      if (raw === undefined) {
        return undefined;
      }
      try {
        values[name] = typedParameterValue(raw, parameter.type || "string");
      } catch (error) {
        void vscode.window.showErrorMessage(`${name}: ${error.message}`);
        return undefined;
      }
    }
    return values;
  };

  const getPinned = () => context.workspaceState.get("azure-pipelines.pinned", []);
  const getPinnedIds = () => new Set(getPinned().map(item => Number(item.id)));
  const pipelinesProvider = new PipelineProvider({
    getApi,
    getPinnedIds,
    currentBranch: false,
    getBranch: currentGitBranch
  });
  const branchProvider = new PipelineProvider({
    getApi,
    getPinnedIds,
    currentBranch: true,
    getBranch: currentGitBranch
  });
  const libraryProvider = new LibraryProvider({getApi});
  let variableNamesCache = {expires: 0, names: []};
  context.subscriptions.push(libraryProvider.onDidChangeTreeData(() => {
    variableNamesCache.expires = 0;
  }));
  const getVariableNames = async () => {
    if (variableNamesCache.expires > Date.now()) {
      return variableNamesCache.names;
    }
    try {
      const api = await getApi(false);
      if (!api) {
        return [];
      }
      const groups = responseItems(await api.listVariableGroups(), "variableGroups");
      variableNamesCache = {
        expires: Date.now() + 30_000,
        names: [...new Set(groups.flatMap(group => Object.keys(group.variables || {})))]
      };
      return variableNamesCache.names;
    } catch {
      return [];
    }
  };

  vscode.window.registerTreeDataProvider("azure-pipelines.pipelines", pipelinesProvider);
  vscode.window.registerTreeDataProvider("azure-pipelines.currentBranch", branchProvider);
  vscode.window.registerTreeDataProvider("azure-pipelines.settings", libraryProvider);

  const expressionDiagnostics = vscode.languages.createDiagnosticCollection("azure-pipelines");
  context.subscriptions.push(expressionDiagnostics);
  const validateYamlDocument = document => {
    const text = document.getText();
    if (!isAzurePipelineDocument(document.uri, text)) {
      expressionDiagnostics.delete(document.uri);
      return;
    }
    const diagnostics = getExpressionDiagnostics(text).map(item => new vscode.Diagnostic(
      new vscode.Range(document.positionAt(item.start), document.positionAt(item.end)),
      item.message,
      vscode.DiagnosticSeverity.Warning
    ));
    expressionDiagnostics.set(document.uri, diagnostics);
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(validateYamlDocument),
    vscode.workspace.onDidChangeTextDocument(event => validateYamlDocument(event.document)),
    vscode.workspace.onDidSaveTextDocument(validateYamlDocument)
  );
  vscode.workspace.textDocuments.forEach(validateYamlDocument);
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
    [
      {language: "yaml", scheme: "file"},
      {language: "azure-pipelines", scheme: "file"}
    ],
    {
      async provideCompletionItems(document, position) {
        const text = document.getText();
        if (!isAzurePipelineDocument(document.uri, text)) {
          return [];
        }
        const offset = document.offsetAt(position);
        const prefix = text.slice(0, offset);
        const candidates = getExpressionCompletions(text, offset);
        if (/\bvariables\.[A-Za-z0-9_.-]*$/.test(prefix) || /\$\([^)]*$/.test(prefix)) {
          const names = await getVariableNames();
          candidates.push(...names.map(label => ({
            label,
            insertText: label,
            detail: "Azure DevOps variable group variable"
          })));
        }
        return candidates.map(candidate => {
          const item = new vscode.CompletionItem(candidate.label, vscode.CompletionItemKind.Function);
          item.insertText = candidate.insertText;
          item.detail = candidate.detail;
          if (candidate.documentation) {
            item.documentation = new vscode.MarkdownString(candidate.documentation);
          }
          return item;
        });
      }
    },
    "$", "{", ".", "[", "("
  ));
  context.subscriptions.push(vscode.languages.registerHoverProvider(
    [
      {language: "yaml", scheme: "file"},
      {language: "azure-pipelines", scheme: "file"}
    ],
    {
      provideHover(document, position) {
        const text = document.getText();
        if (!isAzurePipelineDocument(document.uri, text)) {
          return undefined;
        }
        const result = getExpressionHover(text, document.offsetAt(position));
        return result
          ? new vscode.Hover(new vscode.MarkdownString(`**${result.title}**\n\n${result.body}`))
          : undefined;
      }
    }
  ));

  const refreshAll = () => {
    pipelinesProvider.refresh();
    branchProvider.refresh();
    libraryProvider.refresh();
    void refreshPinnedStatus();
  };

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 40);
  statusBar.command = "azure-pipelines.showPinned";
  const refreshPinnedStatus = async () => {
    const pinned = getPinned();
    if (!pinned.length) {
      statusBar.hide();
      return;
    }
    const api = await getApi(false);
    const statuses = api
      ? await Promise.all(pinned.map(async pipeline => {
          try {
            const response = await api.listRuns(pipeline.id);
            const latest = responseItems(response, "runs")[0];
            return {
              name: pipeline.name,
              status: latest ? (latest.result || latest.state || "unknown") : "No runs"
            };
          } catch {
            return {name: pipeline.name, status: "Unavailable"};
          }
        }))
      : [];
    const first = statuses[0];
    statusBar.text = first
      ? `$(rocket) ${first.name}: ${first.status}`
      : `$(rocket) Azure Pipelines: ${pinned.length}`;
    statusBar.tooltip = [
      "Show pinned Azure Pipelines",
      ...statuses.map(status => `${status.name}: ${status.status}`)
    ].join("\n");
    statusBar.show();
  };
  context.subscriptions.push(statusBar);

  const register = (command, handler) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  register("azure-pipelines.configure", configureConnection);
  register("azure-pipelines.disconnect", async () => {
    const answer = await vscode.window.showWarningMessage(
      "Clear this extension's organization, project, and PAT settings? This does not sign you out of VS Code's Microsoft account.",
      {modal: true},
      "Disconnect"
    );
    if (answer !== "Disconnect") {
      return;
    }
    await secretStorage.delete(PAT_SECRET_KEY);
    const settings = vscode.workspace.getConfiguration("azure-pipelines");
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await settings.update("organization", "", target);
    await settings.update("project", "", target);
    await settings.update("authMethod", "pat", target);
    refreshAll();
  });
  register("azure-pipelines.refresh", refreshAll);
  register("azure-pipelines.refreshSchema", async () => {
    const api = await getApi(true);
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!api || !folder) {
      if (!folder) {
        void vscode.window.showErrorMessage("Open a workspace folder before downloading an organization schema.");
      }
      return;
    }
    const schemaUri = vscode.Uri.joinPath(folder.uri, ".vscode", "azure-pipelines-schema.json");
    const answer = await vscode.window.showWarningMessage(
      "Download the organization's pipeline schema to .vscode/azure-pipelines-schema.json and use it for Azure Pipelines YAML?",
      {modal: true},
      "Download"
    );
    if (answer !== "Download") {
      return;
    }
    try {
      const schema = await api.getYamlSchema();
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ".vscode"));
      await vscode.workspace.fs.writeFile(
        schemaUri,
        Buffer.from(JSON.stringify(schema, null, 2), "utf8")
      );
      const yamlSettings = vscode.workspace.getConfiguration("yaml");
      const mappings = {...yamlSettings.get("schemas", {})};
      delete mappings["https://raw.githubusercontent.com/microsoft/azure-pipelines-vscode/main/service-schema.json"];
      mappings[`./${vscode.workspace.asRelativePath(schemaUri)}`] = [
        "azure-pipelines.yml",
        "azure-pipelines.yaml",
        "**/azure-pipelines.yml",
        "**/azure-pipelines.yaml",
        ".azure-pipelines/**/*.yml",
        ".azure-pipelines/**/*.yaml",
        "**/.azure-pipelines/**/*.yml",
        "**/.azure-pipelines/**/*.yaml",
        "**/azure-pipelines/**/*.yml",
        "**/azure-pipelines/**/*.yaml",
        "**/.pipelines/**/*.yml",
        "**/.pipelines/**/*.yaml",
        "vsts-ci.yml",
        "vsts-ci.yaml",
        ".vsts-ci.yml",
        ".vsts-ci.yaml",
        "**/*.azure-pipelines.yml",
        "**/*.azure-pipelines.yaml"
      ];
      await yamlSettings.update("schemas", mappings, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.getConfiguration("azure-pipelines").update(
        "customSchemaFile",
        `./${vscode.workspace.asRelativePath(schemaUri)}`,
        vscode.ConfigurationTarget.Workspace
      );
      void vscode.window.showInformationMessage("Downloaded and configured the organization pipeline schema.");
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not download the organization schema: ${error.message}`);
    }
  });
  register("azure-pipelines.showPinned", async () => {
    const api = await getApi(true);
    if (!api) {
      return;
    }
    const pinned = getPinned();
    if (!pinned.length) {
      void vscode.window.showInformationMessage("No pinned pipelines.");
      return;
    }
    const choices = await Promise.all(pinned.map(async pipeline => {
      try {
        const runs = await api.listRuns(pipeline.id);
        const latest = (runs.runs || runs.value || [])[0];
        return {
          label: pipeline.name,
          description: latest ? `#${latest.id} ${latest.result || latest.state}` : "No runs",
          pipeline,
          run: latest
        };
      } catch {
        return {label: pipeline.name, description: "Unable to load latest status", pipeline};
      }
    }));
    const selected = await vscode.window.showQuickPick(choices, {placeHolder: "Pinned pipelines"});
    if (selected?.run) {
      const values = await getConnectionValues();
      await vscode.env.openExternal(vscode.Uri.parse(webRunUrl(
        values.organization,
        values.project,
        selected.run
      )));
    }
  });

  register("azure-pipelines.openRun", async argument => {
    const run = getRunArgument(argument);
    if (!run) {
      return;
    }
    const values = await getConnectionValues();
    await vscode.env.openExternal(vscode.Uri.parse(webRunUrl(values.organization, values.project, run)));
  });

  register("azure-pipelines.openEnvironment", async argument => {
    const environment = argument?.environment || argument;
    if (!environment?.id) {
      return;
    }
    const values = await getConnectionValues();
    const url = `https://dev.azure.com/${encodeURIComponent(values.organization)}/${encodeURIComponent(values.project)}/_environments/${encodeURIComponent(environment.id)}`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  });

  register("azure-pipelines.addEnvironment", async () => {
    const api = await getApi(true);
    if (!api) {
      return;
    }
    const name = await vscode.window.showInputBox({prompt: "Environment name", ignoreFocusOut: true});
    if (!name?.trim()) {
      return;
    }
    const description = await vscode.window.showInputBox({
      prompt: "Optional environment description",
      ignoreFocusOut: true
    });
    if (description === undefined) {
      return;
    }
    try {
      await api.createEnvironment({name: name.trim(), description});
      libraryProvider.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not create environment: ${error.message}`);
    }
  });

  register("azure-pipelines.updateEnvironment", async argument => {
    const environment = argument?.environment || argument;
    if (!environment?.id) {
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: "Environment name",
      value: environment.name,
      ignoreFocusOut: true
    });
    if (!name?.trim()) {
      return;
    }
    const description = await vscode.window.showInputBox({
      prompt: "Environment description",
      value: environment.description || "",
      ignoreFocusOut: true
    });
    if (description === undefined) {
      return;
    }
    if (name.trim() === environment.name && description === (environment.description || "")) {
      return;
    }
    try {
      const api = await getApi(true);
      if (api) {
        await api.updateEnvironment(environment.id, {
          name: name.trim(),
          description
        });
        libraryProvider.refresh();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not rename environment: ${error.message}`);
    }
  });

  register("azure-pipelines.deleteEnvironment", async argument => {
    const environment = argument?.environment || argument;
    if (!environment?.id) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Permanently delete environment "${environment.name}"?`,
      {modal: true},
      "Delete"
    );
    if (answer !== "Delete") {
      return;
    }
    try {
      const api = await getApi(true);
      if (api) {
        await api.deleteEnvironment(environment.id);
        libraryProvider.refresh();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not delete environment: ${error.message}`);
    }
  });

  register("azure-pipelines.openDefinition", async argument => {
    let pipeline = getPipelineArgument(argument);
    const api = await getApi(true);
    if (!api) {
      return;
    }
    if (!pipeline?.id) {
      pipeline = await selectPipeline(api);
      if (!pipeline) {
        return;
      }
    }
    try {
      const details = await api.getPipeline(pipeline.id);
      const configuredPath = details.configuration?.path?.replace(/^[/\\]+/, "");
      const folders = vscode.workspace.workspaceFolders || [];
      let matches = [];
      if (configuredPath) {
        for (const folder of folders) {
          const found = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, configuredPath),
            "**/node_modules/**",
            10
          );
          matches.push(...found);
        }
      }
      if (!matches.length) {
        matches = await vscode.workspace.findFiles("**/*.{yml,yaml}", "**/node_modules/**", 500);
      }
      if (!matches.length) {
        void vscode.window.showInformationMessage(
          `Pipeline YAML path was not found in this workspace${configuredPath ? `: ${configuredPath}` : ""}.`
        );
        return;
      }
      const selected = matches.length === 1
        ? matches[0]
        : await vscode.window.showQuickPick(matches.map(uri => ({
            label: vscode.workspace.asRelativePath(uri),
            uri
          })), {placeHolder: "Choose the pipeline YAML file"});
      const uri = selected?.uri || selected;
      if (uri) {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not open pipeline YAML: ${error.message}`);
    }
  });

  register("azure-pipelines.queuePipeline", async argument => {
    let pipeline = getPipelineArgument(argument);
    const api = await getApi(true);
    if (!api) {
      return;
    }
    if (!pipeline?.id) {
      pipeline = await selectPipeline(api);
      if (!pipeline) {
        return;
      }
    }
    const branch = await vscode.window.showInputBox({
      title: `Run ${pipeline.name}`,
      prompt: "Branch or ref to run",
      value: await currentGitBranch() || "main",
      ignoreFocusOut: true
    });
    if (!branch?.trim()) {
      return;
    }
    let templateParameters;
    let variables;
    try {
      const definition = await findPipelineYaml(api, pipeline);
      let parameterDefinitions = [];
      if (definition.uri) {
        const document = await vscode.workspace.openTextDocument(definition.uri);
        parameterDefinitions = getParameterDefinitions(document.getText());
      }
      if (parameterDefinitions.length) {
        templateParameters = await promptPipelineParameters(
          parameterDefinitions,
          "Values read from the pipeline YAML in this workspace"
        );
        if (!templateParameters) {
          return;
        }
      } else {
        const parameterText = await vscode.window.showInputBox({
          title: `Run ${pipeline.name}`,
          prompt: "Optional template parameters as a JSON object (leave blank to skip)",
          ignoreFocusOut: true
        });
        if (parameterText === undefined) {
          return;
        }
        templateParameters = parseJsonObject(parameterText, "Template parameters");
      }
      const variableText = await vscode.window.showInputBox({
        title: `Run ${pipeline.name}`,
        prompt: "Optional run variables as a JSON object (leave blank to skip)",
        password: true,
        ignoreFocusOut: true
      });
      if (variableText === undefined) {
        return;
      }
      variables = normalizeVariables(parseJsonObject(variableText, "Run variables"));
      const logging = await vscode.window.showQuickPick([
        {label: "Standard logging", value: false},
        {label: "Enable verbose diagnostics (System.Debug)", value: true}
      ], {placeHolder: "Pipeline logging"});
      if (!logging) {
        return;
      }
      if (logging.value) {
        variables = normalizeVariables({...variables, "system.debug": true});
      }
    } catch (error) {
      void vscode.window.showErrorMessage(error.message);
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Queue pipeline "${pipeline.name}" on "${branch.trim()}"?`,
      {modal: true},
      "Queue"
    );
    if (answer !== "Queue") {
      return;
    }
    try {
      const run = await api.runPipeline(pipeline.id, {
        branch: branch.trim(),
        templateParameters,
        variables
      });
      refreshAll();
      if (run?.id) {
        void vscode.window.showInformationMessage(`Queued ${pipeline.name} run #${run.id}.`);
        await vscode.env.openExternal(vscode.Uri.parse(webRunUrl(
          (await getConnectionValues()).organization,
          (await getConnectionValues()).project,
          run
        )));
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not queue pipeline: ${error.message}`);
    }
  });

  register("azure-pipelines.cancelRun", async argument => {
    const run = getRunArgument(argument);
    if (!run) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Cancel Azure Pipelines run #${run.id}?`,
      {modal: true},
      "Cancel Run"
    );
    if (answer !== "Cancel Run") {
      return;
    }
    try {
      const api = await getApi(true);
      if (api) {
        await api.cancelRun(run.id);
        refreshAll();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not cancel run: ${error.message}`);
    }
  });

  register("azure-pipelines.retryRun", async argument => {
    const run = getRunArgument(argument);
    if (!run) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Retry Azure Pipelines run #${run.id}?`,
      {modal: true},
      "Retry Run"
    );
    if (answer !== "Retry Run") {
      return;
    }
    try {
      const api = await getApi(true);
      if (api) {
        await api.retryRun(run.id);
        refreshAll();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not retry run: ${error.message}`);
    }
  });

  register("azure-pipelines.openLogs", async argument => {
    const api = await getApi(true);
    if (!api) {
      return;
    }
    const run = argument?.run || argument?.record?.run;
    const pipeline = argument?.pipeline || argument?.record?.pipeline;
    const log = argument?.log;
    const record = argument?.record;
    const logId = record?.log?.id ?? log?.id;
    if (logId === undefined) {
      return;
    }
    try {
      let content;
      if (record && run) {
        content = await api.getBuildLog(run.id, logId);
      } else if (pipeline && run) {
        content = await api.getPipelineLog(pipeline.id, run.id, logId);
      }
      if (content && typeof content === "object") {
        content = content.signedContent || content.url || JSON.stringify(content, null, 2);
      }
      const document = await vscode.workspace.openTextDocument({
        language: "log",
        content: String(content || "No log content was returned.")
      });
      await vscode.window.showTextDocument(document, {preview: false});
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not load log: ${error.message}`);
    }
  });

  register("azure-pipelines.openLogsInBrowser", async argument => {
    const run = argument?.run;
    const record = argument?.record;
    if (!run) {
      return;
    }
    const values = await getConnectionValues();
    await vscode.env.openExternal(vscode.Uri.parse(
      webLogUrl(values.organization, values.project, run, record)
    ));
  });

  register("azure-pipelines.pinPipeline", async argument => {
    const pipeline = getPipelineArgument(argument);
    if (!pipeline?.id) {
      return;
    }
    const pinned = getPinned();
    if (!pinned.some(item => Number(item.id) === Number(pipeline.id))) {
      await context.workspaceState.update("azure-pipelines.pinned", [
        ...pinned,
        {id: pipeline.id, name: pipeline.name}
      ]);
      refreshAll();
    }
  });

  register("azure-pipelines.unpinPipeline", async argument => {
    const pipeline = getPipelineArgument(argument);
    if (!pipeline?.id) {
      return;
    }
    await context.workspaceState.update("azure-pipelines.pinned", getPinned().filter(
      item => Number(item.id) !== Number(pipeline.id)
    ));
    refreshAll();
  });

  const mutateVariableGroup = async (groupNode, mutate) => {
    const api = await getApi(true);
    if (!api || !groupNode?.group) {
      return;
    }
    try {
      const group = await api.getVariableGroup(groupNode.group.id);
      if (group.type && group.type !== "Vsts") {
        void vscode.window.showInformationMessage("Only standard Azure DevOps variable groups can be edited here.");
        return;
      }
      const variables = {...(group.variables || {})};
      const changed = await mutate(variables, group);
      if (!changed) {
        return;
      }
      if (Object.values(group.variables || {}).some(variable => variable.isSecret && variable.value == null)) {
        const answer = await vscode.window.showWarningMessage(
          "Azure DevOps masks existing secret values. Continue updating this group? Unchanged secret values will be sent without their hidden value.",
          {modal: true},
          "Continue"
        );
        if (answer !== "Continue") {
          return;
        }
      }
      const safeVariables = Object.fromEntries(Object.entries(variables).map(([name, variable]) => {
        if (variable.isSecret && variable.value == null) {
          const {value, ...maskedSecret} = variable;
          return [name, maskedSecret];
        }
        return [name, variable];
      }));
      await api.updateVariableGroup({
        id: group.id,
        name: group.name,
        description: group.description,
        type: group.type,
        variables: safeVariables,
        providerData: group.providerData,
        variableGroupProjectReferences: group.variableGroupProjectReferences
      });
      libraryProvider.refresh();
      void vscode.window.showInformationMessage(`Updated variable group "${group.name}".`);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not update variable group: ${error.message}`);
    }
  };

  register("azure-pipelines.addVariableGroup", async () => {
    const api = await getApi(true);
    if (!api) {
      return;
    }
    const name = await vscode.window.showInputBox({prompt: "Variable group name", ignoreFocusOut: true});
    if (!name?.trim()) {
      return;
    }
    const description = await vscode.window.showInputBox({
      prompt: "Optional variable group description",
      ignoreFocusOut: true
    });
    if (description === undefined) {
      return;
    }
    try {
      await api.createVariableGroup(name.trim(), description);
      libraryProvider.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not create variable group: ${error.message}`);
    }
  });

  register("azure-pipelines.updateVariableGroup", async argument => {
    const groupNode = argument?.group ? argument : undefined;
    if (!groupNode) {
      return;
    }
    const api = await getApi(true);
    if (!api) {
      return;
    }
    try {
      const group = await api.getVariableGroup(groupNode.group.id);
      if (group.type && group.type !== "Vsts") {
        void vscode.window.showInformationMessage("Only standard Azure DevOps variable groups can be renamed here.");
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: "Variable group name",
        value: group.name,
        ignoreFocusOut: true
      });
      if (!name?.trim()) {
        return;
      }
      const description = await vscode.window.showInputBox({
        prompt: "Variable group description",
        value: group.description || "",
        ignoreFocusOut: true
      });
      if (description === undefined) {
        return;
      }
      const hiddenSecrets = Object.values(group.variables || {}).some(
        variable => variable.isSecret && variable.value == null
      );
      if (hiddenSecrets) {
        const answer = await vscode.window.showWarningMessage(
          "Azure DevOps masks existing secret values. Continue renaming this group? Unchanged secret values will be sent without their hidden value.",
          {modal: true},
          "Continue"
        );
        if (answer !== "Continue") {
          return;
        }
      }
      const variables = Object.fromEntries(Object.entries(group.variables || {}).map(([key, value]) => {
        if (value.isSecret && value.value == null) {
          const {value: hiddenValue, ...secret} = value;
          return [key, secret];
        }
        return [key, value];
      }));
      await api.updateVariableGroup({
        id: group.id,
        name: name.trim(),
        description,
        type: group.type,
        variables,
        providerData: group.providerData,
        variableGroupProjectReferences: (group.variableGroupProjectReferences || []).map(reference => ({
          ...reference,
          name: name.trim(),
          description
        }))
      });
      libraryProvider.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not update variable group: ${error.message}`);
    }
  });

  register("azure-pipelines.deleteVariableGroup", async argument => {
    const groupNode = argument?.group ? argument : undefined;
    if (!groupNode) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Permanently delete variable group "${groupNode.group.name}"?`,
      {modal: true},
      "Delete"
    );
    if (answer !== "Delete") {
      return;
    }
    try {
      const api = await getApi(true);
      if (api) {
        await api.deleteVariableGroup(groupNode.group.id);
        libraryProvider.refresh();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not delete variable group: ${error.message}`);
    }
  });

  register("azure-pipelines.addVariable", async argument => {
    const groupNode = argument?.group ? argument : undefined;
    if (!groupNode) {
      return;
    }
    const name = await vscode.window.showInputBox({prompt: "Variable name", ignoreFocusOut: true});
    if (!name?.trim()) {
      return;
    }
    const kind = await vscode.window.showQuickPick(["Plain text", "Secret"], {
      placeHolder: "Variable type"
    });
    if (!kind) {
      return;
    }
    const value = await vscode.window.showInputBox({
      prompt: `Value for ${name}`,
      password: kind === "Secret",
      ignoreFocusOut: true
    });
    if (value === undefined) {
      return;
    }
    await mutateVariableGroup(groupNode, variables => {
      if (Object.hasOwn(variables, name)) {
        void vscode.window.showWarningMessage(`Variable "${name}" already exists.`);
        return false;
      }
      variables[name] = {value, isSecret: kind === "Secret"};
      return true;
    });
  });

  register("azure-pipelines.updateVariable", async argument => {
    const groupNode = argument?.group ? argument : undefined;
    const variableName = argument?.variableName;
    if (!groupNode || !variableName) {
      return;
    }
    const current = argument.variable;
    const value = await vscode.window.showInputBox({
      prompt: `New value for ${variableName}${current?.isSecret ? " (secret; current value is hidden)" : ""}`,
      value: current?.isSecret ? "" : (current?.value || ""),
      password: Boolean(current?.isSecret),
      ignoreFocusOut: true
    });
    if (value === undefined) {
      return;
    }
    await mutateVariableGroup(groupNode, variables => {
      const existing = variables[variableName] || {};
      variables[variableName] = {...existing, value};
      return true;
    });
  });

  register("azure-pipelines.deleteVariable", async argument => {
    const groupNode = argument?.group ? argument : undefined;
    const variableName = argument?.variableName;
    if (!groupNode || !variableName) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Delete variable "${variableName}" from "${groupNode.group.name}"?`,
      {modal: true},
      "Delete"
    );
    if (answer !== "Delete") {
      return;
    }
    await mutateVariableGroup(groupNode, variables => {
      if (!Object.hasOwn(variables, variableName)) {
        return false;
      }
      delete variables[variableName];
      return true;
    });
  });

  register("azure-pipelines.copyVariable", async argument => {
    if (argument?.variableName) {
      await vscode.env.clipboard.writeText(argument.variableName);
      void vscode.window.showInformationMessage(`Copied variable name "${argument.variableName}".`);
    }
  });

  register("azure-pipelines.copyVariableValue", async argument => {
    const variable = argument?.variable;
    if (!variable || variable.isSecret) {
      return;
    }
    await vscode.env.clipboard.writeText(String(variable.value ?? ""));
    void vscode.window.showInformationMessage("Copied variable value.");
  });

  const interval = vscode.workspace.getConfiguration("azure-pipelines").get("refreshInterval", 60);
  let refreshTimer;
  if (interval > 0) {
    refreshTimer = setInterval(refreshAll, Math.max(30, interval) * 1000);
    context.subscriptions.push({dispose: () => clearInterval(refreshTimer)});
  }

  context.subscriptions.push({dispose: () => {
    pipelinesProvider.onDidChangeTreeDataEmitter.dispose();
    branchProvider.onDidChangeTreeDataEmitter.dispose();
    libraryProvider.onDidChangeTreeDataEmitter.dispose();
  }});
  refreshPinnedStatus();
}

function deactivate() {}

module.exports = {activate, deactivate};
