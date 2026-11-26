"use strict";

const {execFile} = require("child_process");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const {promisify} = require("util");
const vscode = require("vscode");
const {AzureDevOpsApi} = require("./api");
const {normalizeVariables, parseJsonObject, webLogUrl, webRunUrl} = require("./helpers");
const {parseAzureDevOpsProjectUrl, parseGitRemotes} = require("./git");
const {mergeLogContent, renderErrors, renderLogBody, renderLogHtml} = require("./logViewer");
const {LibraryProvider, PipelineProvider, responseItems} = require("./providers");
const {
  getExpressionCompletions,
  getExpressionDiagnostics,
  getExpressionHover,
  getAzureYamlCompletions,
  getPipelineResourceDiagnostics,
  getScheduleDiagnostics,
  getScheduleInlayHints,
  getTaskHover,
  getTaskReferenceCompletions,
  getTaskReferenceDiagnostics,
  getTemplateParameterCompletions,
  getTemplateParameterDiagnostics,
  getTemplateParameterTemplateAt,
  getTemplateReferenceAt,
  getTemplateReferences,
  addVariableGroupReference,
  getTaskInputCompletions,
  getTaskInputDiagnostics,
  getParameterDefinitions,
  isAzurePipelineDocument,
  isTaskInputCompletionPosition,
  isTemplateParameterCompletionPosition,
  parsePipelineYaml,
  parseTemplateReference,
  parameterPromptKind,
  resolveTemplatePaths,
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

function activeWorkspaceFolder() {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
}

function normalizeRefName(ref) {
  const raw = String(ref || "").trim();
  if (!raw) {
    return undefined;
  }
  return raw.startsWith("refs/") ? raw : `refs/heads/${raw}`;
}

async function pipelineDefaultRef(api, pipeline) {
  const candidates = [pipeline];
  if (pipeline?.id) {
    for (const method of ["getPipeline", "getBuildDefinition"]) {
      if (typeof api[method] !== "function") {
        continue;
      }
      try {
        candidates.push(await api[method](pipeline.id));
      } catch {
        // Try the next endpoint before requiring the user to enter a branch.
      }
    }
  }
  for (const candidate of candidates) {
    const configured = normalizeRefName(
      candidate?.repository?.defaultBranch ||
      candidate?.configuration?.repository?.defaultBranch
    );
    if (configured) {
      return configured;
    }
  }
  return undefined;
}

function activate(context) {
  const secretStorage = context.secrets;
  const remoteTemplateContents = new Map();
  const remoteTemplateScheme = "azure-pipelines-template";
  const remoteTemplateChanged = new vscode.EventEmitter();
  context.subscriptions.push(remoteTemplateChanged);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(
    remoteTemplateScheme,
    {
      onDidChange: remoteTemplateChanged.event,
      provideTextDocumentContent(uri) {
        return remoteTemplateContents.get(uri.query) || "";
      }
    }
  ));
  const readConnectionValues = async folder => {
    const settings = vscode.workspace.getConfiguration(
      "azure-pipelines",
      folder?.uri
    );
    let serverUrl = settings.get("serverUrl", "").trim();
    const authMethod = settings.get("authMethod", "pat");
    let organization = settings.get("organization", "").trim();
    let project = settings.get("project", "").trim();
    let repository;
    if (!organization || !project) {
      const remoteValues = await getAzureDevOpsRemotes(folder);
      if (remoteValues.length === 1) {
        organization ||= remoteValues[0].organization;
        project ||= remoteValues[0].project;
        serverUrl ||= remoteValues[0].serverUrl || "";
        repository = remoteValues[0].repository;
      }
    }
    const useMicrosoftAuth = authMethod === "microsoft" && !serverUrl;
    let token;
    if (useMicrosoftAuth) {
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
      organization,
      project,
      serverUrl: serverUrl || undefined,
      apiVersion: settings.get("apiVersion", "7.1"),
      repository,
      workspaceFolder: folder,
      token,
      authMethod,
      authType: useMicrosoftAuth ? "bearer" : "pat"
    };
  };

  const getAzureDevOpsRemotes = async folder => {
    if (!folder) {
      return [];
    }
    try {
      const {stdout} = await execFileAsync("git", [
        "config",
        "--get-regexp",
        "^remote\\..*\\.url$"
      ], {
        cwd: folder.uri.fsPath,
        windowsHide: true,
        timeout: 3000
      });
      return parseGitRemotes(stdout);
    } catch {
      return [];
    }
  };

  const getConnectionValues = async folder => {
    if (folder) {
      return readConnectionValues(folder);
    }

    const activeFolder = activeWorkspaceFolder();
    if (activeFolder) {
      return readConnectionValues(activeFolder);
    }

    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 1) {
      return readConnectionValues(folders[0]);
    }

    const settings = vscode.workspace.getConfiguration("azure-pipelines");
    const configuredOrganization = settings.get("organization", "").trim();
    const configuredProject = settings.get("project", "").trim();
    const configuredServerUrl = settings.get("serverUrl", "").trim();
    if ((configuredOrganization || configuredServerUrl) && configuredProject) {
      return readConnectionValues(undefined);
    }

    const detected = await Promise.all(folders.map(readConnectionValues));
    const unique = new Map(detected
      .filter(values => (values.organization || values.serverUrl) && values.project)
      .map(values => [
        `${(values.serverUrl || values.organization).toLowerCase()}/${values.project.toLowerCase()}`,
        values
      ]));
    return unique.size === 1 ? unique.values().next().value : readConnectionValues(undefined);
  };

  let configuring;
  const configureConnection = async argument => {
    if (configuring) {
      return configuring;
    }
    configuring = (async () => {
      const folders = vscode.workspace.workspaceFolders || [];
      let targetFolder = argument?.workspaceFolder || activeWorkspaceFolder();
      if (!targetFolder && folders.length > 1) {
        const selected = await vscode.window.showQuickPick(folders.map(folder => ({
          label: folder.name,
          description: folder.uri.fsPath,
          folder
        })), {placeHolder: "Choose the workspace folder to configure"});
        targetFolder = selected?.folder;
        if (!targetFolder) {
          return false;
        }
      } else if (!targetFolder && folders.length === 1) {
        targetFolder = folders[0];
      }
      const values = await getConnectionValues(targetFolder);
      const targetType = await vscode.window.showQuickPick([
        {label: "Azure DevOps Services", value: "services"},
        {label: "Azure DevOps Server", value: "server"}
      ], {placeHolder: "Choose Azure DevOps Services or an on-premises server"});
      if (!targetType) {
        return false;
      }
      let serverUrl = "";
      let organization;
      let project;
      if (targetType.value === "server") {
        serverUrl = await vscode.window.showInputBox({
          title: "Azure DevOps Server connection",
          prompt: "Collection URL, for example https://ado.example.com/tfs/DefaultCollection",
          value: values.serverUrl || "",
          ignoreFocusOut: true,
          validateInput(value) {
            try {
              const url = new URL(value);
              return url.protocol === "https:" &&
                !url.username &&
                !url.password &&
                !url.search &&
                !url.hash
                ? undefined
                : "Use an HTTPS collection URL without credentials, query, or fragment.";
            } catch {
              return "Enter a valid collection URL.";
            }
          }
        });
        if (serverUrl === undefined) {
          return false;
        }
        const organizationValue = await vscode.window.showInputBox({
          title: "Azure DevOps Server connection",
          prompt: "Optional collection label (the collection URL above is used for API requests)",
          value: values.organization,
          ignoreFocusOut: true
        });
        if (organizationValue === undefined) {
          return false;
        }
        organization = organizationValue.trim() || "server";
        project = await vscode.window.showInputBox({
          title: "Azure DevOps Server connection",
          prompt: values.repository
            ? `Detected from Git remote for repository "${values.repository}"`
            : "Project name or ID",
          value: values.project,
          ignoreFocusOut: true
        });
        if (!project?.trim()) {
          return false;
        }
      } else {
        const projectUrl = await vscode.window.showInputBox({
          title: "Azure DevOps connection",
          prompt: "Paste the project URL, for example dev.azure.com/organization/project (https:// is optional)",
          value: values.organization && values.project
            ? `https://dev.azure.com/${encodeURIComponent(values.organization)}/${encodeURIComponent(values.project)}`
            : "",
          ignoreFocusOut: true,
          validateInput(value) {
            return parseAzureDevOpsProjectUrl(value)
              ? undefined
              : "Enter dev.azure.com/{organization}/{project} or {organization}.visualstudio.com/{project}; https:// is optional.";
          }
        });
        if (projectUrl === undefined) {
          return false;
        }
        const parsedUrl = parseAzureDevOpsProjectUrl(projectUrl);
        if (!parsedUrl) {
          return false;
        }
        organization = parsedUrl.organization;
        project = parsedUrl.project;
      }
      const authOptions = targetType.value === "server"
        ? [{label: "Personal access token", description: "Stored in VS Code SecretStorage", value: "pat"}]
        : [
            {label: "Microsoft account sign-in", description: "Uses your VS Code Microsoft session", value: "microsoft"},
            {label: "Personal access token", description: "Use if sign-in is blocked; stored securely by VS Code", value: "pat"}
          ];
      const selectedAuth = await vscode.window.showQuickPick(authOptions, {
        placeHolder: "Choose Azure DevOps authentication"
      });
      if (!selectedAuth) {
        return false;
      }
      let authMethod = selectedAuth.value;
      let token;
      if (authMethod === "microsoft") {
        try {
          const session = await vscode.authentication.getSession(
            "microsoft",
            AZURE_DEVOPS_SCOPES,
            {createIfNone: true}
          );
          token = session?.accessToken;
        } catch (error) {
          const fallback = await vscode.window.showErrorMessage(
            `Microsoft sign-in could not get an Azure DevOps token. Your organization's access policy may block this resource. ${error.message}`,
            "Use a PAT instead"
          );
          if (fallback !== "Use a PAT instead") {
            return false;
          }
          authMethod = "pat";
        }
        if (authMethod === "microsoft" && !token) {
          return false;
        }
      }
      if (authMethod === "pat") {
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
      const settings = vscode.workspace.getConfiguration("azure-pipelines", targetFolder?.uri);
      await settings.update("organization", organization, target);
      await settings.update("project", project.trim(), target);
      await settings.update("serverUrl", serverUrl || "", target);
      await settings.update("authMethod", authMethod, target);
      if (authMethod === "pat") {
        await secretStorage.store(PAT_SECRET_KEY, token);
      }
      try {
        const api = new AzureDevOpsApi({
          organization,
          project: project.trim(),
          serverUrl: serverUrl || undefined,
          apiVersion: settings.get("apiVersion", "7.1"),
          token,
          authType: authMethod === "microsoft" && !serverUrl ? "bearer" : "pat",
          workspaceFolder: targetFolder
        });
        const pipelines = responseItems(await api.listPipelines(), "pipelines");
        if (pipelines.length) {
          await vscode.window.showInformationMessage(
            `Connection saved using ${
              authMethod === "pat" ? "a personal access token" : selectedAuth.label
            }. Found ${pipelines.length} pipeline${pipelines.length === 1 ? "" : "s"}.`
          );
        } else {
          await vscode.window.showWarningMessage(
            "Connection succeeded, but no pipelines were returned. Check the project URL and the account's Build (Read) permission."
          );
        }
      } catch (error) {
        await vscode.window.showErrorMessage(
          `Connection was saved, but pipelines could not be loaded: ${error.message}`
        );
      }
      refreshAll();
      return targetFolder || true;
    })();
    try {
      return await configuring;
    } finally {
      configuring = undefined;
    }
  };

  const getApi = async (promptForSetup = false, folder) => {
    let values = await getConnectionValues(folder);
    if ((!values.organization && !values.serverUrl || !values.project || !values.token) && promptForSetup) {
      const answer = await vscode.window.showWarningMessage(
        "Configure an Azure DevOps organization, project, and authentication method to use pipeline features.",
        "Configure"
      );
      if (answer === "Configure") {
        const configuredFolder = await configureConnection({workspaceFolder: folder});
        values = await getConnectionValues(
          folder || (configuredFolder?.uri ? configuredFolder : undefined)
        );
      }
    }
    if ((!values.organization && !values.serverUrl) || !values.project || !values.token) {
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
      pipeline: {...pipeline, workspaceFolder: api.workspaceFolder}
    })), {placeHolder: "Select an Azure Pipeline"});
    return selected?.pipeline;
  };

  const findPipelineYaml = async (api, pipeline) => {
    const details = await api.getPipeline(pipeline.id);
    const configuredPath = details.configuration?.path?.replace(/^[/\\]+/, "");
    const folders = pipeline.workspaceFolder
      ? [pipeline.workspaceFolder]
      : vscode.workspace.workspaceFolders || [];
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

  const getWorkspaceFolders = () => vscode.workspace.workspaceFolders || [];
  const getPinned = () => context.workspaceState.get("azure-pipelines.pinned", []);
  const getPinnedWorkspaceFolder = pipeline => {
    const folders = getWorkspaceFolders();
    if (pipeline.workspaceFolder) {
      return folders.find(folder => folder.uri.toString() === pipeline.workspaceFolder);
    }
    return folders.length === 1 ? folders[0] : undefined;
  };
  const pinnedPipelineMatches = (item, pipeline) =>
    Number(item.id) === Number(pipeline.id) &&
    (item.workspaceFolder || "") === (pipeline.workspaceFolder?.uri.toString() || "");
  const getPinnedIds = workspaceFolder => {
    const folderUri = workspaceFolder?.uri.toString();
    return new Set(getPinned()
      .filter(item => item.workspaceFolder === folderUri || (!item.workspaceFolder && !folderUri))
      .map(item => Number(item.id)));
  };
  const pipelinesProvider = new PipelineProvider({
    getApi,
    getPinnedIds,
    currentBranch: false,
    getBranch: currentGitBranch,
    getWorkspaceFolders
  });
  const branchProvider = new PipelineProvider({
    getApi,
    getPinnedIds,
    currentBranch: true,
    getBranch: currentGitBranch,
    getWorkspaceFolders
  });
  const libraryProvider = new LibraryProvider({getApi, getWorkspaceFolders});
  const variableNamesCache = new Map();
  const getCatalogConnectionKey = values => {
    const connection = String(values.serverUrl || values.organization || "")
      .trim()
      .replace(/\/+$/, "")
      .toLowerCase();
    return connection
      ? JSON.stringify([connection, String(values.project || "").trim().toLowerCase()])
      : "";
  };
  const taskCatalogCache = new Map();
  const taskCatalogRequests = new Map();
  const templateContentCache = new Map();
  context.subscriptions.push(libraryProvider.onDidChangeTreeData(() => {
    variableNamesCache.clear();
  }));
  const getVariableNames = async folder => {
    const values = await getConnectionValues(folder);
    const cacheKey = [
      folder?.uri.toString() || "global",
      values.serverUrl || values.organization,
      values.project
    ].join("|").toLowerCase();
    const cached = variableNamesCache.get(cacheKey);
    if (cached?.expires > Date.now()) {
      return cached.names;
    }
    try {
      const api = await getApi(false, folder);
      if (!api) {
        return [];
      }
      const groups = responseItems(await api.listVariableGroups(), "variableGroups");
      const result = {
        expires: Date.now() + 30_000,
        names: [...new Set(groups.flatMap(group => Object.keys(group.variables || {})))]
      };
      variableNamesCache.set(cacheKey, result);
      return result.names;
    } catch {
      return [];
    }
  };
  const getTaskDefinitions = async folder => {
    const values = await getConnectionValues(folder);
    const connection = getCatalogConnectionKey(values);
    if (!connection) {
      return [];
    }
    const cached = taskCatalogCache.get(connection);
    if (cached?.expires > Date.now()) {
      return cached.definitions;
    }
    if (taskCatalogRequests.has(connection)) {
      return taskCatalogRequests.get(connection);
    }
    const promise = (async () => {
      try {
        const api = await getApi(false, folder);
        if (!api) {
          taskCatalogCache.set(connection, {
            expires: Date.now() + 60 * 1000,
            definitions: []
          });
          return [];
        }
        const definitions = responseItems(await api.listTaskDefinitions(), "tasks");
        taskCatalogCache.set(connection, {
          expires: Date.now() + 60 * 60 * 1000,
          definitions
        });
        return definitions;
      } catch {
        taskCatalogCache.set(connection, {
          expires: Date.now() + 60 * 1000,
          definitions: []
        });
        return [];
      }
    })();
    taskCatalogRequests.set(connection, promise);
    try {
      return await promise;
    } finally {
      if (taskCatalogRequests.get(connection) === promise) {
        taskCatalogRequests.delete(connection);
      }
    }
  };
  const yamlCatalogCache = new Map();
  const getYamlCatalogs = async folder => {
    const values = await getConnectionValues(folder);
    const connection = getCatalogConnectionKey(values);
    const cached = yamlCatalogCache.get(connection);
    if (cached?.expires > Date.now()) {
      return cached;
    }
    const api = await getApi(false, folder);
    if (!api) {
      return {pools: [], environments: []};
    }
    const [poolResult, environmentResult] = await Promise.allSettled([
      api.listAgentPools(),
      api.listEnvironments()
    ]);
    const result = {
      connection,
      expires: Date.now() + 30_000,
      pools: poolResult.status === "fulfilled"
        ? responseItems(poolResult.value, "pool")
        : [],
      environments: environmentResult.status === "fulfilled"
        ? responseItems(environmentResult.value, "environments")
        : []
    };
    yamlCatalogCache.set(connection, result);
    return result;
  };
  const getTemplateText = async (document, referencePath) => {
    const reference = parseTemplateReference(referencePath);
    if (!reference) {
      return undefined;
    }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!reference.repository) {
      const candidates = resolveTemplatePaths(
        reference.path,
        document.uri.fsPath,
        folder?.uri.fsPath
      );
      for (const candidate of candidates) {
        try {
          const uri = vscode.Uri.file(candidate);
          const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
          return {content, uri};
        } catch {
          // Try the next supported path base.
        }
      }
      return undefined;
    }

    const pipeline = parsePipelineYaml(document.getText()) || {};
    const repositoryResource = (pipeline.resources?.repositories || []).find(repository =>
      repository?.repository?.toLowerCase() === reference.repository.toLowerCase()
    );
    if (!repositoryResource?.name) {
      return undefined;
    }
    const api = await getApi(false, folder);
    if (!api) {
      return undefined;
    }
    const requestedName = String(repositoryResource.name).toLowerCase();
    const nameParts = requestedName.split("/");
    const requestedLeaf = nameParts.pop();
    const repositoryProject = nameParts.pop() || api.project;
    const repositories = responseItems(
      await api.listGitRepositories(repositoryProject),
      "repositories"
    );
    const repository = repositories.find(item =>
      String(item.id).toLowerCase() === requestedLeaf ||
      String(item.name || "").toLowerCase() === requestedLeaf
    );
    if (!repository) {
      return undefined;
    }
    const rawRef = String(repositoryResource.ref || repository.defaultBranch || "refs/heads/main");
    const versionType = rawRef.startsWith("refs/tags/") ? "tag" : "branch";
    const version = rawRef.replace(/^refs\/(?:heads|tags)\//, "");
    const cacheKey = [
      api.serverUrl || api.organization,
      repositoryProject,
      repository.id,
      reference.path,
      versionType,
      version
    ].join("|");
    const cached = templateContentCache.get(cacheKey);
    if (cached?.expires > Date.now()) {
      return cached;
    }
    const remoteText = await api.getGitItem(
      repository.id,
      `/${reference.path.replace(/^\/+/, "")}`,
      version,
      versionType,
      repositoryProject
    );
    const content = typeof remoteText === "string"
      ? remoteText
      : typeof remoteText?.content === "string" ? remoteText.content : undefined;
    if (content === undefined) {
      return undefined;
    }
    const documentId = crypto.createHash("sha256").update(cacheKey).digest("hex");
    const uri = vscode.Uri.from({
      scheme: remoteTemplateScheme,
      path: `/${documentId}/${path.basename(reference.path)}`,
      query: documentId
    });
    remoteTemplateContents.set(documentId, content);
    remoteTemplateChanged.fire(uri);
    const result = {content, uri, expires: Date.now() + 60_000};
    templateContentCache.set(cacheKey, result);
    return result;
  };

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("azure-pipelines.pipelines", pipelinesProvider),
    vscode.window.registerTreeDataProvider("azure-pipelines.currentBranch", branchProvider),
    vscode.window.registerTreeDataProvider("azure-pipelines.settings", libraryProvider)
  );

  const gitRepositorySubscriptions = new Map();
  const watchGitRepository = repository => {
    if (gitRepositorySubscriptions.has(repository)) {
      return;
    }
    const subscription = repository.state?.onDidChange?.(() => branchProvider.refresh());
    if (subscription) {
      gitRepositorySubscriptions.set(repository, subscription);
      context.subscriptions.push(subscription);
    }
  };
  const connectGitApi = async () => {
    const extension = vscode.extensions.getExtension("vscode.git");
    if (!extension) {
      return;
    }
    try {
      const git = extension.isActive ? extension.exports : await extension.activate();
      const api = git.getAPI(1);
      api.repositories.forEach(watchGitRepository);
      if (api.onDidOpenRepository) {
        context.subscriptions.push(api.onDidOpenRepository(watchGitRepository));
      }
      if (api.onDidCloseRepository) {
        context.subscriptions.push(api.onDidCloseRepository(repository => {
          gitRepositorySubscriptions.get(repository)?.dispose();
          gitRepositorySubscriptions.delete(repository);
          branchProvider.refresh();
        }));
      }
    } catch {
      // Branch changes still refresh when the user manually refreshes the tree.
    }
  };
  void connectGitApi();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    pipelinesProvider.refresh();
    branchProvider.refresh();
  }));

  const expressionDiagnostics = vscode.languages.createDiagnosticCollection("azure-pipelines");
  context.subscriptions.push(expressionDiagnostics);
  const yamlValidationTimers = new Map();
  const validateYamlDocument = async document => {
    const text = document.getText();
    if (!isAzurePipelineDocument(document.uri, text)) {
      expressionDiagnostics.delete(document.uri);
      return;
    }
    const version = document.version;
    const diagnostics = getExpressionDiagnostics(text).map(item => new vscode.Diagnostic(
      new vscode.Range(document.positionAt(item.start), document.positionAt(item.end)),
      item.message,
      vscode.DiagnosticSeverity.Warning
    ));
    diagnostics.push(...getScheduleDiagnostics(text).map(item => new vscode.Diagnostic(
      new vscode.Range(document.positionAt(item.start), document.positionAt(item.end)),
      item.message,
      vscode.DiagnosticSeverity.Warning
    )));
    if (/\b(?:pool|environment)\s*:/i.test(text)) {
      const catalogs = await getYamlCatalogs(vscode.workspace.getWorkspaceFolder(document.uri));
      if (document.version !== version) {
        return;
      }
      diagnostics.push(...getPipelineResourceDiagnostics(text, catalogs).map(item => new vscode.Diagnostic(
        new vscode.Range(document.positionAt(item.start), document.positionAt(item.end)),
        item.message,
        vscode.DiagnosticSeverity.Warning
      )));
    }
    expressionDiagnostics.set(document.uri, diagnostics);
    if (/^\s*-\s*task\s*:/m.test(text)) {
      const definitions = await getTaskDefinitions(vscode.workspace.getWorkspaceFolder(document.uri));
      if (document.version !== version) {
        return;
      }
      diagnostics.push(...getTaskInputDiagnostics(text, definitions).map(item => new vscode.Diagnostic(
        new vscode.Range(document.positionAt(item.start), document.positionAt(item.end)),
        item.message,
        vscode.DiagnosticSeverity.Warning
      )));
      diagnostics.push(...getTaskReferenceDiagnostics(text, definitions).map(item => new vscode.Diagnostic(
        new vscode.Range(document.positionAt(item.start), document.positionAt(item.end)),
        item.message,
        vscode.DiagnosticSeverity.Warning
      )));
      expressionDiagnostics.set(document.uri, diagnostics);
    }
    const templatePaths = [...new Set(getTemplateReferences(text).map(reference => reference.path))];
    for (const templatePath of templatePaths) {
      const template = await getTemplateText(document, templatePath).catch(() => undefined);
      if (document.version !== version) {
        return;
      }
      if (template) {
        diagnostics.push(...getTemplateParameterDiagnostics(text, template.content, templatePath).map(item =>
          new vscode.Diagnostic(
            new vscode.Range(document.positionAt(item.start), document.positionAt(item.end)),
            item.message,
            vscode.DiagnosticSeverity.Warning
          )
        ));
      }
    }
    expressionDiagnostics.set(document.uri, diagnostics);
  };
  const validateYamlDocumentNow = document => {
    const key = document.uri.toString();
    const timer = yamlValidationTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      yamlValidationTimers.delete(key);
    }
    void validateYamlDocument(document);
  };
  const scheduleYamlValidation = document => {
    const key = document.uri.toString();
    const previousTimer = yamlValidationTimers.get(key);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }
    yamlValidationTimers.set(key, setTimeout(() => {
      yamlValidationTimers.delete(key);
      void validateYamlDocument(document);
    }, 300));
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(validateYamlDocumentNow),
    vscode.workspace.onDidChangeTextDocument(event => scheduleYamlValidation(event.document)),
    vscode.workspace.onDidSaveTextDocument(validateYamlDocumentNow),
    vscode.workspace.onDidCloseTextDocument(document => {
      const key = document.uri.toString();
      const timer = yamlValidationTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        yamlValidationTimers.delete(key);
      }
      expressionDiagnostics.delete(document.uri);
    }),
    {
      dispose() {
        for (const timer of yamlValidationTimers.values()) {
          clearTimeout(timer);
        }
        yamlValidationTimers.clear();
      }
    }
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
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        const definitions = await getTaskDefinitions(workspaceFolder);
        const candidates = getExpressionCompletions(text, offset, definitions);
        candidates.push(...getTaskReferenceCompletions(text, offset, definitions));
        if (/\b(?:pool|environment)\b/i.test(prefix)) {
          const catalogs = await getYamlCatalogs(workspaceFolder);
          candidates.push(...getAzureYamlCompletions(text, offset, catalogs));
        } else {
          candidates.push(...getAzureYamlCompletions(text, offset));
        }
        if (isTaskInputCompletionPosition(text, offset)) {
          candidates.push(...getTaskInputCompletions(text, offset, definitions));
        }
        if (isTemplateParameterCompletionPosition(text, offset)) {
          const templatePath = getTemplateParameterTemplateAt(text, offset);
          const template = templatePath
            ? await getTemplateText(document, templatePath).catch(() => undefined)
            : undefined;
          if (template) {
            candidates.push(...getTemplateParameterCompletions(text, offset, template.content));
          }
        }
        if (/\bvariables\.[A-Za-z0-9_.-]*$/.test(prefix) || /\$\([^)]*$/.test(prefix)) {
          const names = await getVariableNames(workspaceFolder);
          candidates.push(...names.map(label => ({
            label,
            insertText: label,
            detail: "Azure DevOps variable group variable"
          })));
        }
        return candidates.map(candidate => {
          const kind = candidate.kind === "property"
            ? vscode.CompletionItemKind.Property
            : candidate.kind === "value"
              ? vscode.CompletionItemKind.Value
            : candidate.kind === "reference"
              ? vscode.CompletionItemKind.Reference
              : vscode.CompletionItemKind.Function;
          const item = new vscode.CompletionItem(candidate.label, kind);
          item.insertText = candidate.insertText;
          item.detail = candidate.detail;
          if (candidate.documentation) {
            item.documentation = new vscode.MarkdownString(candidate.documentation);
          }
          return item;
        });
      }
    },
    "$", "{", ".", "[", "(", " "
  ));
  context.subscriptions.push(vscode.languages.registerHoverProvider(
    [
      {language: "yaml", scheme: "file"},
      {language: "azure-pipelines", scheme: "file"}
    ],
    {
      async provideHover(document, position) {
        const text = document.getText();
        if (!isAzurePipelineDocument(document.uri, text)) {
          return undefined;
        }
        const offset = document.offsetAt(position);
        const result = getExpressionHover(text, offset) || getTaskHover(
          text,
          offset,
          await getTaskDefinitions(vscode.workspace.getWorkspaceFolder(document.uri))
        );
        return result
          ? new vscode.Hover(new vscode.MarkdownString(`**${result.title}**\n\n${result.body}`))
          : undefined;
      }
    }
  ));
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    [
      {language: "yaml", scheme: "file"},
      {language: "azure-pipelines", scheme: "file"}
    ],
    {
      async provideDefinition(document, position) {
        const text = document.getText();
        if (!isAzurePipelineDocument(document.uri, text)) {
          return undefined;
        }
        const reference = getTemplateReferenceAt(text, document.offsetAt(position));
        if (!reference) {
          return undefined;
        }
        const template = await getTemplateText(document, reference.path).catch(() => undefined);
        if (template) {
          return new vscode.Location(template.uri, new vscode.Position(0, 0));
        }
        return undefined;
      }
    }
  ));
  context.subscriptions.push(vscode.languages.registerInlayHintsProvider(
    [
      {language: "yaml", scheme: "file"},
      {language: "azure-pipelines", scheme: "file"}
    ],
    {
      provideInlayHints(document, range) {
        const text = document.getText();
        if (!isAzurePipelineDocument(document.uri, text)) {
          return [];
        }
        return getScheduleInlayHints(text)
          .map(hint => ({
            hint,
            position: document.positionAt(hint.position)
          }))
          .filter(item => range.contains(item.position))
          .map(({hint, position}) => {
            const result = new vscode.InlayHint(position, hint.label, vscode.InlayHintKind.Type);
            result.paddingLeft = true;
            return result;
          });
      }
    }
  ));

  const refreshAll = () => {
    pipelinesProvider.refresh();
    branchProvider.refresh();
    libraryProvider.refresh();
    void refreshPinnedStatus();
    void refreshConnectionStatus();
  };

  const connectionStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 41);
  connectionStatus.name = "Azure DevOps Connection";
  connectionStatus.command = "azure-pipelines.switchConnection";
  let connectionStatusRequest = 0;
  const refreshConnectionStatus = async () => {
    const request = ++connectionStatusRequest;
    const values = await getConnectionValues();
    if (request !== connectionStatusRequest) {
      return;
    }

    const hasTarget = Boolean((values.organization || values.serverUrl) && values.project);
    if (!hasTarget) {
      const multipleFolders = (vscode.workspace.workspaceFolders || []).length > 1;
      connectionStatus.text = multipleFolders
        ? "$(organization) Select Azure DevOps project"
        : "$(plug) Connect Azure DevOps";
      connectionStatus.tooltip = multipleFolders
        ? "Open a file in the workspace to show its Azure DevOps project, or click to configure a connection."
        : "No Azure DevOps connection configured. Click to connect or switch organizations and projects.";
    } else {
      const organization = values.organization || values.serverUrl;
      const state = values.token ? "Signed in" : "Sign-in required";
      connectionStatus.text = `${values.token ? "$(organization)" : "$(sign-in)"} ${organization} / ${values.project}`;
      connectionStatus.tooltip = [
        `Azure DevOps: ${state}`,
        `${values.serverUrl ? "Server" : "Organization"}: ${organization}`,
        `Project: ${values.project}`,
        "Click to connect or switch organizations and projects."
      ].join("\n");
    }
    connectionStatus.show();
  };
  context.subscriptions.push(
    connectionStatus,
    vscode.window.onDidChangeActiveTextEditor(() => void refreshConnectionStatus()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshConnectionStatus())
  );
  void refreshConnectionStatus();

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 40);
  statusBar.command = "azure-pipelines.showPinned";
  const refreshPinnedStatus = async () => {
    const pinned = getPinned();
    if (!pinned.length) {
      statusBar.hide();
      return;
    }
    const folders = getWorkspaceFolders();
    const statuses = await Promise.all(pinned.map(async pipeline => {
      const workspaceFolder = getPinnedWorkspaceFolder(pipeline);
      if (
        (!pipeline.workspaceFolder && folders.length > 1) ||
        (pipeline.workspaceFolder && !workspaceFolder)
      ) {
        return {name: pipeline.name, status: "Workspace unavailable"};
      }
      const api = await getApi(false, workspaceFolder);
      if (!api) {
        return {name: pipeline.name, status: "Unavailable"};
      }
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
    }));
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
  register("azure-pipelines.switchConnection", configureConnection);
  register("azure-pipelines.disconnect", async () => {
    const folders = vscode.workspace.workspaceFolders || [];
    let folder = activeWorkspaceFolder();
    if (!folder && folders.length === 1) {
      folder = folders[0];
    } else if (!folder && folders.length > 1) {
      const selected = await vscode.window.showQuickPick(folders.map(candidate => ({
        label: candidate.name,
        description: candidate.uri.fsPath,
        folder: candidate
      })), {placeHolder: "Choose the workspace folder to disconnect"});
      folder = selected?.folder;
      if (!folder) {
        return;
      }
    }
    const answer = await vscode.window.showWarningMessage(
      `Clear Azure DevOps settings${folder ? ` for "${folder.name}"` : ""} and the stored PAT? This does not sign you out of VS Code's Microsoft account.`,
      {modal: true},
      "Disconnect"
    );
    if (answer !== "Disconnect") {
      return;
    }
    await secretStorage.delete(PAT_SECRET_KEY);
    const settings = vscode.workspace.getConfiguration("azure-pipelines", folder?.uri);
    const targets = folder
      ? [vscode.ConfigurationTarget.WorkspaceFolder]
      : vscode.workspace.workspaceFolders?.length
        ? [vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.Global]
        : [vscode.ConfigurationTarget.Global];
    for (const target of targets) {
      await settings.update("organization", "", target);
      await settings.update("project", "", target);
      await settings.update("serverUrl", "", target);
      await settings.update("authMethod", "pat", target);
    }
    refreshAll();
  });
  register("azure-pipelines.refresh", refreshAll);
  register("azure-pipelines.refreshSchema", async () => {
    const folders = vscode.workspace.workspaceFolders || [];
    let folder = activeWorkspaceFolder();
    if (!folder && folders.length === 1) {
      folder = folders[0];
    } else if (!folder && folders.length > 1) {
      const selected = await vscode.window.showQuickPick(folders.map(candidate => ({
        label: candidate.name,
        description: candidate.uri.fsPath,
        folder: candidate
      })), {placeHolder: "Choose the workspace folder for the downloaded schema"});
      folder = selected?.folder;
    }
    const api = await getApi(true, folder);
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
      const target = vscode.ConfigurationTarget.WorkspaceFolder;
      const yamlSettings = vscode.workspace.getConfiguration("yaml", folder.uri);
      const mappings = {...yamlSettings.get("schemas", {})};
      delete mappings["https://raw.githubusercontent.com/microsoft/azure-pipelines-vscode/main/service-schema.json"];
      mappings["./.vscode/azure-pipelines-schema.json"] = [
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
      await yamlSettings.update("schemas", mappings, target);
      await vscode.workspace.getConfiguration("azure-pipelines", folder.uri).update(
        "customSchemaFile",
        "./.vscode/azure-pipelines-schema.json",
        target
      );
      void vscode.window.showInformationMessage("Downloaded and configured the organization pipeline schema.");
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not download the organization schema: ${error.message}`);
    }
  });
  register("azure-pipelines.showPinned", async () => {
    const pinned = getPinned();
    if (!pinned.length) {
      void vscode.window.showInformationMessage("No pinned pipelines.");
      return;
    }
    const folders = getWorkspaceFolders();
    const choices = await Promise.all(pinned.map(async pipeline => {
      const workspaceFolder = getPinnedWorkspaceFolder(pipeline);
      if (
        (!pipeline.workspaceFolder && folders.length > 1) ||
        (pipeline.workspaceFolder && !workspaceFolder)
      ) {
        return {
          label: pipeline.name,
          description: "Workspace unavailable; pin this pipeline again",
          pipeline
        };
      }
      const api = await getApi(false, workspaceFolder);
      if (!api) {
        return {
          label: pipeline.name,
          description: "Azure DevOps connection unavailable",
          pipeline
        };
      }
      try {
        const runs = await api.listRuns(pipeline.id);
        const latest = responseItems(runs, "runs")[0];
        return {
          label: pipeline.name,
          description: latest ? `#${latest.id} ${latest.result || latest.state}` : "No runs",
          pipeline,
          run: latest,
          api
        };
      } catch {
        return {
          label: pipeline.name,
          description: "Unable to load latest status",
          pipeline,
          api
        };
      }
    }));
    const selected = await vscode.window.showQuickPick(choices, {placeHolder: "Pinned pipelines"});
    if (selected?.run && selected.api) {
      await vscode.env.openExternal(vscode.Uri.parse(webRunUrl(
        selected.api.organization,
        selected.api.project,
        selected.run,
        selected.api.serverUrl
      )));
    }
  });

  register("azure-pipelines.openRun", async argument => {
    const run = getRunArgument(argument);
    if (!run) {
      return;
    }
    const values = await getConnectionValues(argument?.pipeline?.workspaceFolder);
    await vscode.env.openExternal(vscode.Uri.parse(
      webRunUrl(values.organization, values.project, run, values.serverUrl)
    ));
  });

  register("azure-pipelines.openEnvironment", async argument => {
    const environment = argument?.environment || argument;
    if (!environment?.id) {
      return;
    }
    const values = await getConnectionValues(argument?.workspaceFolder);
    const base = values.serverUrl
      ? `${values.serverUrl.replace(/\/+$/, "")}/${encodeURIComponent(values.project)}`
      : `https://dev.azure.com/${encodeURIComponent(values.organization)}/${encodeURIComponent(values.project)}`;
    const url = `${base}/_environments/${encodeURIComponent(environment.id)}`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  });

  register("azure-pipelines.addEnvironment", async argument => {
    const api = await getApi(true, argument?.workspaceFolder);
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
      const api = await getApi(true, argument?.workspaceFolder);
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
      const api = await getApi(true, argument?.workspaceFolder);
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
    const api = await getApi(true, pipeline?.workspaceFolder);
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
      const folders = pipeline.workspaceFolder
        ? [pipeline.workspaceFolder]
        : vscode.workspace.workspaceFolders || [];
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
      if (!matches.length && !pipeline.workspaceFolder) {
        matches = await vscode.workspace.findFiles("**/*.{yml,yaml}", "**/node_modules/**", 500);
      } else if (!matches.length) {
        matches = await vscode.workspace.findFiles(
          new vscode.RelativePattern(pipeline.workspaceFolder, "**/*.{yml,yaml}"),
          "**/node_modules/**",
          500
        );
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

  register("azure-pipelines.addVariableGroupToPipeline", async argument => {
    const pipeline = getPipelineArgument(argument);
    if (!pipeline?.id) {
      return;
    }
    const api = await getApi(true, pipeline.workspaceFolder);
    if (!api) {
      return;
    }

    try {
      const groups = responseItems(await api.listVariableGroups(), "variableGroups")
        .filter(group => group?.name);
      if (!groups.length) {
        void vscode.window.showInformationMessage("No variable groups are available in this project.");
        return;
      }
      const selected = await vscode.window.showQuickPick(groups.map(group => ({
        label: group.name,
        description: group.type === "AzureKeyVault"
          ? "Key Vault"
          : `${Object.keys(group.variables || {}).length} variables`,
        group
      })), {placeHolder: `Choose a variable group for ${pipeline.name || "this pipeline"}`});
      if (!selected) {
        return;
      }

      const {uri} = await findPipelineYaml(api, pipeline);
      if (!uri) {
        void vscode.window.showInformationMessage(
          `Pipeline YAML was not found in this workspace${pipeline.workspaceFolder ? " folder" : ""}.`
        );
        return;
      }

      const document = await vscode.workspace.openTextDocument(uri);
      const result = addVariableGroupReference(document.getText(), selected.group.name);
      if (!result.added) {
        void vscode.window.showInformationMessage(
          `Variable group "${selected.group.name}" is already referenced by "${pipeline.name}".`
        );
        return;
      }

      const editor = await vscode.window.showTextDocument(document);
      const range = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      );
      const applied = await editor.edit(editBuilder => editBuilder.replace(range, result.text));
      if (!applied) {
        throw new Error("The pipeline YAML could not be updated.");
      }
      void vscode.window.showInformationMessage(
        `Added variable group "${selected.group.name}" to "${pipeline.name}". Save the YAML file to keep the change.`
      );
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not add variable group to pipeline: ${error.message}`);
    }
  });

  register("azure-pipelines.queuePipeline", async argument => {
    let pipeline = getPipelineArgument(argument);
    const api = await getApi(true, pipeline?.workspaceFolder);
    if (!api) {
      return;
    }
    if (!pipeline?.id) {
      pipeline = await selectPipeline(api);
      if (!pipeline) {
        return;
      }
    }
    const defaultBranch = await pipelineDefaultRef(api, pipeline);
    const branch = await vscode.window.showInputBox({
      title: `Run ${pipeline.name}`,
      prompt: defaultBranch
        ? "Branch or ref to run"
        : "Could not determine the pipeline's configured branch; enter the branch or ref to run",
      value: defaultBranch || "",
      placeHolder: "refs/heads/<branch>",
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
        const values = await getConnectionValues(pipeline.workspaceFolder);
        await vscode.env.openExternal(vscode.Uri.parse(webRunUrl(
          values.organization,
          values.project,
          run,
          values.serverUrl
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
      const api = await getApi(true, argument?.pipeline?.workspaceFolder);
      if (api) {
        await api.cancelRun(run.id);
        refreshAll();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not cancel run: ${error.message}`);
    }
  });

  register("azure-pipelines.deleteRun", async argument => {
    const run = getRunArgument(argument);
    if (!run) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Delete completed Azure Pipelines run #${run.id}? This cannot be undone.`,
      {modal: true},
      "Delete Run"
    );
    if (answer !== "Delete Run") {
      return;
    }
    try {
      const api = await getApi(true, argument?.pipeline?.workspaceFolder);
      if (api) {
        await api.deleteRun(run.id);
        refreshAll();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not delete run: ${error.message}`);
    }
  });

  register("azure-pipelines.togglePipelineQueue", async argument => {
    const pipeline = getPipelineArgument(argument);
    if (!pipeline?.id) {
      return;
    }
    try {
      const api = await getApi(true, pipeline.workspaceFolder);
      if (!api) {
        return;
      }
      const definition = await api.getBuildDefinition(pipeline.id);
      const status = String(definition.queueStatus || "").toLowerCase();
      const nextStatus = status === "paused" || status === "disabled" ? "enabled" : "paused";
      const action = status === "paused" ? "Resume" : status === "disabled" ? "Enable" : "Pause";
      const answer = await vscode.window.showWarningMessage(
        `${action} pipeline "${pipeline.name || definition.name}"?`,
        {modal: true},
        `${action} Pipeline`
      );
      if (answer !== `${action} Pipeline`) {
        return;
      }
      await api.setPipelineQueueStatus(pipeline.id, nextStatus, definition);
      refreshAll();
      void vscode.window.showInformationMessage(
        `Pipeline ${action.toLowerCase()}d.`
      );
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not update pipeline queue status: ${error.message}`);
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
      const api = await getApi(true, argument?.pipeline?.workspaceFolder);
      if (api) {
        await api.retryRun(run.id);
        refreshAll();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not retry run: ${error.message}`);
    }
  });

  const retryStageOrJob = async (argument, retryJob = false) => {
    const run = argument?.run;
    const pipeline = argument?.pipeline;
    const record = argument?.record;
    const stageRefName = argument?.stageRefName || record?.identifier || record?.name;
    if (!run || !stageRefName) {
      return;
    }
    if (run.state !== "completed") {
      void vscode.window.showInformationMessage("A stage can only be retried after the run has completed.");
      return;
    }
    const action = retryJob ? "Retry failed jobs in stage" : "Retry stage";
    const answer = await vscode.window.showWarningMessage(
      `${action} "${stageRefName}" in run #${run.id}?`,
      {modal: true},
      "Retry"
    );
    if (answer !== "Retry") {
      return;
    }
    try {
      const api = await getApi(true, pipeline?.workspaceFolder);
      if (api) {
        await api.retryStage(run.id, stageRefName);
        refreshAll();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not retry stage: ${error.message}`);
    }
  };
  register("azure-pipelines.retryStage", argument => retryStageOrJob(argument));
  register("azure-pipelines.retryJob", argument => retryStageOrJob(argument, true));

  register("azure-pipelines.downloadArtifact", async argument => {
    const artifact = argument?.artifact;
    const run = argument?.run;
    if (!artifact?.name || !run?.id) {
      return;
    }
    try {
      const api = await getApi(true, argument.pipeline?.workspaceFolder);
      if (!api) {
        return;
      }
      const safeName = `${String(artifact.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")}.zip`;
      const uri = await vscode.window.showSaveDialog({
        saveLabel: "Download Artifact",
        filters: {Zip: ["zip"]},
        defaultUri: vscode.Uri.file(path.join(os.homedir(), safeName))
      });
      if (!uri) {
        return;
      }
      const content = await api.downloadBuildArtifact(run.id, artifact.name);
      await vscode.workspace.fs.writeFile(uri, content);
      void vscode.window.showInformationMessage(`Downloaded "${artifact.name}" to ${uri.fsPath}.`);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not download artifact: ${error.message}`);
    }
  });

  const decideApproval = async (argument, status) => {
    const approval = argument?.approval || argument;
    if (!approval?.id) {
      return;
    }
    const action = status === "approved" ? "Approve" : "Reject";
    const answer = await vscode.window.showWarningMessage(
      `${action} this Azure Pipelines approval gate?`,
      {modal: true},
      action
    );
    if (answer !== action) {
      return;
    }
    const comment = await vscode.window.showInputBox({
      prompt: "Optional approval comment",
      ignoreFocusOut: true
    });
    if (comment === undefined) {
      return;
    }
    try {
      const api = await getApi(true, argument?.workspaceFolder);
      if (api) {
        await api.updateApproval(approval.id, status, comment);
        libraryProvider.refresh();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not ${action.toLowerCase()} approval: ${error.message}`);
    }
  };
  register("azure-pipelines.approveApproval", argument => decideApproval(argument, "approved"));
  register("azure-pipelines.rejectApproval", argument => decideApproval(argument, "rejected"));

  register("azure-pipelines.openLogs", async argument => {
    const run = argument?.run || argument?.record?.run;
    const pipeline = argument?.pipeline || argument?.record?.pipeline;
    const log = argument?.log;
    const record = argument?.record;
    const logId = record?.log?.id ?? log?.id;
    const api = await getApi(true, pipeline?.workspaceFolder);
    if (!api || logId === undefined || !run) {
      return;
    }
    try {
      const fetchContent = async startLine => {
        let content = record
          ? await api.getBuildLog(run.id, logId, startLine)
          : await api.getPipelineLog(pipeline.id, run.id, logId);
        if (content && typeof content === "object") {
          content = content.signedContent || content.url || JSON.stringify(content, null, 2);
        }
        return String(content || "");
      };
      let content = await fetchContent();
      const panel = vscode.window.createWebviewPanel(
        "azurePipelinesLog",
        `Run #${run.id} - ${record?.name || log?.name || "Log"}`,
        vscode.ViewColumn.Active,
        {enableScripts: true, retainContextWhenHidden: true}
      );
      const nonce = crypto.randomBytes(16).toString("base64");
      panel.webview.html = renderLogHtml(content, {
        cspSource: panel.webview.cspSource,
        nonce
      });

      const jumpToError = async message => {
        const file = message.file;
        const folder = pipeline?.workspaceFolder;
        if (!file) {
          return;
        }
        const roots = folder ? [folder] : (vscode.workspace.workspaceFolders || []);
        const normalizedFile = file.replace(/\\/g, "/");
        const checkoutIndex = normalizedFile.lastIndexOf("/s/");
        const candidates = [
          ...(path.isAbsolute(file) ? [path.resolve(file)] : []),
          ...(checkoutIndex >= 0 ? [normalizedFile.slice(checkoutIndex + 3)] : []),
          ...(!path.isAbsolute(file) ? [file] : [])
        ];
        const targets = [...new Set(candidates.flatMap(candidate =>
          path.isAbsolute(candidate)
            ? [path.resolve(candidate)]
            : roots.map(root => path.resolve(root.uri.fsPath, candidate))
        ))];
        for (const target of targets) {
          const root = roots.find(candidate => {
            const relative = path.relative(candidate.uri.fsPath, target);
            return relative === "" || (!relative.startsWith(`..${path.sep}`) &&
              relative !== ".." && !path.isAbsolute(relative));
          });
          if (!root) {
            continue;
          }
          try {
            const uri = vscode.Uri.file(target);
            const stat = await vscode.workspace.fs.stat(uri);
            if (!(stat.type & vscode.FileType.File)) {
              continue;
            }
            const document = await vscode.workspace.openTextDocument(uri);
            const line = Math.min(
              Math.max(0, (message.line || 1) - 1),
              Math.max(0, document.lineCount - 1)
            );
            const column = Math.min(
              Math.max(0, (message.column || 1) - 1),
              document.lineAt(line).text.length
            );
            const position = new vscode.Position(line, column);
            await vscode.window.showTextDocument(document, {
              selection: new vscode.Range(position, position)
            });
            return;
          } catch {
            // Continue through workspace roots until a matching local file is found.
          }
        }
        void vscode.window.showInformationMessage(`Source file from the build log was not found in this workspace: ${file}`);
      };
      const messageSubscription = panel.webview.onDidReceiveMessage(message => {
        if (message.type === "jump") {
          void jumpToError(message);
        }
      });
      panel.onDidDispose(() => messageSubscription.dispose());

      let polling = false;
      let timer;
      const update = async () => {
        if (polling) {
          return;
        }
        polling = true;
        try {
          const lineCount = content.split(/\r?\n/).length - (/\r?\n$/.test(content) ? 1 : 0);
          const [build, latest] = await Promise.all([
            api.getBuild(run.id).catch(() => undefined),
            fetchContent(record ? Math.max(0, lineCount - 1) : undefined)
          ]);
          if (record) {
            const merged = mergeLogContent(content, latest);
            if (merged !== undefined) {
              content = merged;
            } else {
              const complete = await fetchContent();
              if (complete.length >= content.length) {
                content = complete;
              }
            }
          } else if (latest.length > content.length && latest.startsWith(content)) {
            content = latest;
          } else if (latest !== content && latest.length >= content.length) {
            content = latest;
          }
          const active = build ? build.status !== "completed" : run.state !== "completed";
          await panel.webview.postMessage({
            type: "update",
            logHtml: renderLogBody(content),
            errorsHtml: renderErrors(content),
            active
          });
          if (!active && timer) {
            clearInterval(timer);
            timer = undefined;
          }
        } catch {
          // A temporary network failure does not close the log viewer.
        } finally {
          polling = false;
        }
      };
      if (run.state !== "completed") {
        timer = setInterval(() => void update(), 5000);
        panel.onDidDispose(() => clearInterval(timer));
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not load log: ${error.message}`);
    }
  });

  register("azure-pipelines.openLogsInBrowser", async argument => {
    const run = argument?.run;
    const record = argument?.record;
    const pipeline = argument?.pipeline;
    if (!run) {
      return;
    }
    const values = await getConnectionValues(pipeline?.workspaceFolder);
    await vscode.env.openExternal(vscode.Uri.parse(
      webLogUrl(values.organization, values.project, run, record, values.serverUrl)
    ));
  });

  register("azure-pipelines.pinPipeline", async argument => {
    const pipeline = getPipelineArgument(argument);
    if (!pipeline?.id) {
      return;
    }
    const pinned = getPinned();
    if (!pinned.some(item => pinnedPipelineMatches(item, pipeline))) {
      const workspaceFolder = pipeline.workspaceFolder?.uri.toString();
      await context.workspaceState.update("azure-pipelines.pinned", [
        ...pinned,
        {
          id: pipeline.id,
          name: pipeline.name,
          ...(workspaceFolder ? {workspaceFolder} : {})
        }
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
      item => !pinnedPipelineMatches(item, pipeline)
    ));
    refreshAll();
  });

  const mutateVariableGroup = async (groupNode, mutate) => {
    const api = await getApi(true, groupNode?.workspaceFolder);
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

  register("azure-pipelines.addSecureFile", async argument => {
    const api = await getApi(true, argument?.workspaceFolder);
    if (!api) {
      return;
    }
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "Upload Secure File"
    });
    const fileUri = selected?.[0];
    if (!fileUri) {
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: "Secure file name",
      value: path.basename(fileUri.fsPath),
      ignoreFocusOut: true
    });
    if (!name?.trim()) {
      return;
    }
    try {
      const contents = await vscode.workspace.fs.readFile(fileUri);
      await api.uploadSecureFile(name.trim(), contents);
      libraryProvider.refresh();
      void vscode.window.showInformationMessage(`Uploaded secure file "${name.trim()}".`);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not upload secure file: ${error.message}`);
    }
  });

  register("azure-pipelines.deleteSecureFile", async argument => {
    const file = argument?.secureFile;
    if (!file) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Delete secure file "${file.name}"? Pipelines using this file may stop working.`,
      {modal: true},
      "Delete"
    );
    if (answer !== "Delete") {
      return;
    }
    try {
      const api = await getApi(true, argument.workspaceFolder);
      if (!api) {
        return;
      }
      await api.deleteSecureFile(file.id);
      libraryProvider.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not delete secure file: ${error.message}`);
    }
  });

  register("azure-pipelines.addServiceConnection", async argument => {
    const api = await getApi(true, argument?.workspaceFolder);
    if (!api) {
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: "Service connection name",
      ignoreFocusOut: true
    });
    if (!name?.trim()) {
      return;
    }
    const endpointUrl = await vscode.window.showInputBox({
      prompt: "Service URL",
      ignoreFocusOut: true
    });
    if (!endpointUrl?.trim()) {
      return;
    }
    const auth = await vscode.window.showQuickPick([
      {label: "No authentication", value: "None"},
      {label: "Token", value: "Token"},
      {label: "Username and password", value: "UsernamePassword"}
    ], {placeHolder: "Choose generic service connection authentication"});
    if (!auth) {
      return;
    }
    const parameters = {};
    if (auth.value === "Token") {
      const token = await vscode.window.showInputBox({
        prompt: "Access token",
        password: true,
        ignoreFocusOut: true
      });
      if (!token) {
        return;
      }
      parameters.apitoken = token;
    } else if (auth.value === "UsernamePassword") {
      const username = await vscode.window.showInputBox({
        prompt: "Username",
        ignoreFocusOut: true
      });
      if (username === undefined) {
        return;
      }
      const password = await vscode.window.showInputBox({
        prompt: "Password",
        password: true,
        ignoreFocusOut: true
      });
      if (password === undefined) {
        return;
      }
      parameters.username = username;
      parameters.password = password;
    }
    try {
      await api.createServiceEndpoint({
        name: name.trim(),
        url: endpointUrl.trim(),
        type: "generic",
        authorization: {scheme: auth.value, parameters},
        data: {},
        isShared: false,
        isReady: true
      });
      libraryProvider.refresh();
      void vscode.window.showInformationMessage(`Created service connection "${name.trim()}".`);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not create service connection: ${error.message}`);
    }
  });

  register("azure-pipelines.deleteServiceConnection", async argument => {
    const endpoint = argument?.serviceConnection;
    if (!endpoint) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Delete service connection "${endpoint.name}"?`,
      {modal: true},
      "Delete"
    );
    if (answer !== "Delete") {
      return;
    }
    try {
      const api = await getApi(true, argument.workspaceFolder);
      if (!api) {
        return;
      }
      await api.deleteServiceEndpoint(endpoint.id);
      libraryProvider.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not delete service connection: ${error.message}`);
    }
  });

  register("azure-pipelines.addVariableGroup", async argument => {
    const api = await getApi(true, argument?.workspaceFolder);
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
    const api = await getApi(true, groupNode.workspaceFolder);
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
      const api = await getApi(true, groupNode.workspaceFolder);
      if (api) {
        await api.deleteVariableGroup(groupNode.group.id);
        libraryProvider.refresh();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not delete variable group: ${error.message}`);
    }
  });

  const mutatePipelineDefinition = async (variableNode, mutate) => {
    const definitionNode = variableNode?.definition ? variableNode : undefined;
    if (!definitionNode) {
      return;
    }
    const api = await getApi(true, variableNode.workspaceFolder);
    if (!api) {
      return;
    }
    try {
      const definition = await api.getBuildDefinition(definitionNode.definition.id);
      const variables = {...(definition.variables || {})};
      if (!mutate(variables, definition)) {
        return;
      }
      const hasMaskedSecrets = Object.values(definition.variables || {}).some(variable =>
        variable.isSecret && (variable.value == null || variable.value === "********")
      );
      if (hasMaskedSecrets) {
        const answer = await vscode.window.showWarningMessage(
          "Azure DevOps masks existing pipeline secret values. Continue updating this definition? Unchanged secrets will be preserved without resending their hidden values.",
          {modal: true},
          "Continue"
        );
        if (answer !== "Continue") {
          return;
        }
      }
      definition.variables = Object.fromEntries(Object.entries(variables).map(([name, variable]) => {
        if (variable.isSecret && (variable.value == null || variable.value === "********")) {
          const {value, ...maskedSecret} = variable;
          return [name, maskedSecret];
        }
        return [name, variable];
      }));
      await api.updateBuildDefinition(definition);
      libraryProvider.refresh();
      void vscode.window.showInformationMessage(`Updated variables for pipeline "${definition.name}".`);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not update pipeline variables: ${error.message}`);
    }
  };

  register("azure-pipelines.addPipelineVariable", async argument => {
    if (!argument?.definition) {
      return;
    }
    const name = await vscode.window.showInputBox({prompt: "Pipeline variable name", ignoreFocusOut: true});
    if (!name?.trim()) {
      return;
    }
    const kind = await vscode.window.showQuickPick(["Plain text", "Secret"], {
      placeHolder: "Pipeline variable type"
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
    await mutatePipelineDefinition(argument, variables => {
      const duplicate = Object.keys(variables).some(key => key.toLowerCase() === name.trim().toLowerCase());
      if (duplicate) {
        void vscode.window.showWarningMessage(`Pipeline variable "${name}" already exists.`);
        return false;
      }
      variables[name.trim()] = {
        value,
        isSecret: kind === "Secret",
        allowOverride: false
      };
      return true;
    });
  });

  register("azure-pipelines.updatePipelineVariable", async argument => {
    if (!argument?.definition || !argument.variableName) {
      return;
    }
    const current = argument.variable || {};
    const value = await vscode.window.showInputBox({
      prompt: `New value for ${argument.variableName}${current.isSecret ? " (secret; current value is hidden)" : ""}`,
      value: current.isSecret ? "" : (current.value || ""),
      password: Boolean(current.isSecret),
      ignoreFocusOut: true
    });
    if (value === undefined || (current.isSecret && !value)) {
      return;
    }
    await mutatePipelineDefinition(argument, variables => {
      const existing = variables[argument.variableName] || {};
      variables[argument.variableName] = {...existing, value};
      return true;
    });
  });

  register("azure-pipelines.deletePipelineVariable", async argument => {
    if (!argument?.definition || !argument.variableName) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Delete pipeline variable "${argument.variableName}" from "${argument.definition.name}"?`,
      {modal: true},
      "Delete"
    );
    if (answer !== "Delete") {
      return;
    }
    await mutatePipelineDefinition(argument, variables => {
      if (!Object.hasOwn(variables, argument.variableName)) {
        return false;
      }
      delete variables[argument.variableName];
      return true;
    });
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

  let refreshTimer;
  const configureRefreshTimer = () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
    const interval = vscode.workspace.getConfiguration("azure-pipelines").get("refreshInterval", 60);
    if (interval > 0) {
      refreshTimer = setInterval(refreshAll, Math.max(30, interval) * 1000);
    }
  };
  configureRefreshTimer();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("azure-pipelines.refreshInterval")) {
        configureRefreshTimer();
      }
      if (event.affectsConfiguration("azure-pipelines")) {
        void refreshConnectionStatus();
      }
    }),
    {dispose: () => clearInterval(refreshTimer)}
  );

  context.subscriptions.push({dispose: () => {
    pipelinesProvider.onDidChangeTreeDataEmitter.dispose();
    branchProvider.onDidChangeTreeDataEmitter.dispose();
    libraryProvider.onDidChangeTreeDataEmitter.dispose();
  }});
  refreshPinnedStatus();
}

function deactivate() {}

module.exports = {activate, deactivate};
