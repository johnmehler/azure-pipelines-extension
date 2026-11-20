"use strict";

const vscode = require("vscode");

function responseItems(response, key) {
  if (Array.isArray(response)) {
    return response;
  }
  return response?.[key] || response?.value || [];
}

function orderedRecords(records) {
  return records
    .map((record, index) => ({record, index, order: Number(record.order)}))
    .sort((left, right) => {
      const leftOrder = Number.isFinite(left.order) ? left.order : Number.MAX_SAFE_INTEGER;
      const rightOrder = Number.isFinite(right.order) ? right.order : Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.index - right.index;
    })
    .map(item => item.record);
}

function statusIcon(run) {
  const state = String(run.state || "").toLowerCase();
  const result = String(run.result || "").toLowerCase();
  if ([
    "inprogress",
    "cancelling",
    "canceling",
    "notstarted",
    "queued",
    "pending",
    "postponed"
  ].includes(state)) {
    return new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.blue"));
  }
  if (result === "succeeded") {
    return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
  }
  if (result === "failed" || result === "canceled") {
    return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
  }
  if (result === "partiallysucceeded") {
    return new vscode.ThemeIcon("warning", new vscode.ThemeColor("testing.iconQueued"));
  }
  return new vscode.ThemeIcon("circle-outline");
}

function runLabel(run) {
  const name = run.name || `Run ${run.id}`;
  const status = run.state === "completed" ? (run.result || "completed") : (run.state || "unknown");
  return `#${run.id} ${name} - ${status}`;
}

function pipelineNode(pipeline, pinnedIds = new Set(), workspaceFolder) {
  const pinned = pinnedIds.has(Number(pipeline.id));
  const workspaceKey = workspaceFolder?.uri.toString() || "";
  const item = new vscode.TreeItem(
    pipeline.name || `Pipeline ${pipeline.id}`,
    vscode.TreeItemCollapsibleState.Collapsed
  );
  item.id = `pipeline-${workspaceKey}-${pipeline.id}`;
  item.contextValue = pinned ? "azurePipelinePinned" : "azurePipeline";
  item.pipeline = pipeline;
  item.workspaceFolder = workspaceFolder;
  if (workspaceFolder) {
    item.pipeline = {...pipeline, workspaceFolder};
  }
  item.description = pipeline.folder && pipeline.folder !== "\\" ? pipeline.folder : undefined;
  item.iconPath = new vscode.ThemeIcon(pinned ? "pin" : "repo");
  item.tooltip = `Pipeline ${pipeline.id}${pipeline.folder ? `\n${pipeline.folder}` : ""}`;
  return item;
}

function runNode(run, pipeline, workspaceFolder = pipeline.workspaceFolder) {
  const active = run.state !== "completed";
  const workspaceKey = workspaceFolder?.uri.toString() || "";
  const item = new vscode.TreeItem(runLabel(run), vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `run-${workspaceKey}-${pipeline.id}-${run.id}`;
  item.contextValue = active ? "azurePipelineRunActive" : "azurePipelineRunCompleted";
  item.run = run;
  item.pipeline = pipeline;
  item.workspaceFolder = workspaceFolder;
  item.iconPath = statusIcon(run);
  item.description = run.createdDate ? new Date(run.createdDate).toLocaleString() : undefined;
  item.tooltip = `${pipeline.name} / run ${run.id}\n${run.resources?.repositories?.self?.refName || "Branch unavailable"}`;
  item.command = {
    command: "azure-pipelines.openRun",
    title: "Open Run in Browser",
    arguments: [{run, pipeline}]
  };
  return item;
}

function informationNode(label, detail, command, argumentsList) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = detail;
  item.iconPath = new vscode.ThemeIcon(command ? "gear" : "info");
  if (command) {
    item.command = {command, title: label, arguments: argumentsList};
  }
  return item;
}

function recordNode(record, hasChildren, run, pipeline, timelineId, workspaceFolder, parentStageRefName) {
  const item = new vscode.TreeItem(
    record.name || record.type || "Pipeline step",
    hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
  );
  item.id = `timeline-${workspaceFolder?.uri.toString() || ""}-${pipeline.id}-${timelineId || "main"}-${record.id}`;
  const recordType = String(record.type || "").toLowerCase();
  const stageRefName = recordType === "stage"
    ? (record.identifier || record.name)
    : parentStageRefName;
  item.contextValue = record.log
    ? "azurePipelineLog"
    : recordType === "stage"
      ? "azurePipelineStageRetry"
      : recordType === "job" && stageRefName
        ? "azurePipelineJobRetry"
        : "azurePipelineTimelineRecord";
  item.description = [
    record.result || record.state || record.currentOperation,
    record.attempt > 1 ? `Attempt ${record.attempt}` : ""
  ].filter(Boolean).join(" - ");
  item.iconPath = statusIcon({state: record.state, result: record.result});
  item.tooltip = [record.type, record.currentOperation, record.errorCount ? `${record.errorCount} errors` : ""]
    .filter(Boolean)
    .join("\n");
  if (record.log?.id !== undefined) {
    item.command = {
      command: "azure-pipelines.openLogs",
      title: "Open Logs",
      arguments: [{record, run, pipeline, timelineId}]
    };
  }
  item.record = record;
  item.run = run;
  item.pipeline = pipeline;
  item.timelineId = timelineId;
  item.workspaceFolder = workspaceFolder;
  item.stageRefName = stageRefName;
  return item;
}

function workspaceNode(folder) {
  const item = new vscode.TreeItem(folder.name, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `workspace-${folder.uri.toString()}`;
  item.contextValue = "azurePipelineWorkspace";
  item.workspaceFolder = folder;
  item.description = folder.uri.fsPath;
  item.iconPath = new vscode.ThemeIcon("root-folder");
  return item;
}

function artifactsNode(run, pipeline, workspaceFolder) {
  const item = new vscode.TreeItem("Artifacts", vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `artifacts-${workspaceFolder?.uri.toString() || ""}-${pipeline.id}-${run.id}`;
  item.contextValue = "azurePipelineArtifacts";
  item.iconPath = new vscode.ThemeIcon("archive");
  item.run = run;
  item.pipeline = pipeline;
  item.workspaceFolder = workspaceFolder;
  item.artifactsRoot = true;
  return item;
}

class PipelineProvider {
  constructor({getApi, getPinnedIds, currentBranch = false, getBranch, getWorkspaceFolders}) {
    this.getApi = getApi;
    this.getPinnedIds = getPinnedIds;
    this.currentBranch = currentBranch;
    this.getBranch = getBranch;
    this.getWorkspaceFolders = getWorkspaceFolders;
    this.onDidChangeTreeDataEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    this.timelines = new Map();
    this.branchRuns = new Map();
  }

  refresh() {
    this.timelines.clear();
    this.branchRuns.clear();
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    try {
      if (!element) {
        const folders = this.getWorkspaceFolders?.() || [];
        if (folders.length > 1) {
          return folders.map(workspaceNode);
        }
      }

      const workspaceFolder = element?.workspaceFolder || element?.pipeline?.workspaceFolder;
      const api = await this.getApi(false, workspaceFolder);
      if (!api) {
        return [informationNode(
          "Configure Azure DevOps",
          workspaceFolder
            ? `No connection detected for ${workspaceFolder.name}`
            : "Organization, project, and authentication required",
          "azure-pipelines.configure",
          workspaceFolder ? [{workspaceFolder}] : undefined
        )];
      }

      if (element?.contextValue === "azurePipelineWorkspace") {
        if (this.currentBranch) {
          return this.getPipelinesForBranch(api, element.workspaceFolder);
        }
        const pipelines = responseItems(await api.listPipelines(), "pipelines");
        return pipelines.map(pipeline => pipelineNode(
          pipeline,
          this.getPinnedIds(),
          element.workspaceFolder
        ));
      }

      if (!element) {
        if (this.currentBranch) {
          return this.getPipelinesForBranch(api);
        }
        const pipelines = responseItems(await api.listPipelines(), "pipelines");
        if (!pipelines.length) {
          return [informationNode("No pipelines found", "Check the selected project and permissions")];
        }
        return pipelines.map(item => pipelineNode(item, this.getPinnedIds()));
      }

      if (element.previousAttempt && element.run && element.pipeline) {
        const timeline = await this.getTimeline(api, element.run, element.previousAttempt.timelineId);
        const record = (timeline?.records || []).find(item => item.id === element.previousAttempt.recordId);
        return record
          ? [recordNode(
              {...record, attempt: element.previousAttempt.attempt},
              (timeline.records || []).some(child => child.parentId === record.id),
              element.run,
              element.pipeline,
              element.previousAttempt.timelineId,
              workspaceFolder
            )]
          : [];
      }

      if (element.record && element.run && element.pipeline) {
        const timeline = await this.getTimeline(api, element.run, element.timelineId);
        const children = orderedRecords((timeline?.records || [])
          .filter(record => record.parentId === element.record.id))
          .map(record => recordNode(
            record,
            (timeline.records || []).some(child => child.parentId === record.id),
            element.run,
            element.pipeline,
            element.timelineId,
            workspaceFolder,
            element.stageRefName
          ));
        const previous = (element.record.previousAttempts || []).map(attempt => {
          const item = new vscode.TreeItem(
            `Previous attempt ${attempt.attempt}`,
            vscode.TreeItemCollapsibleState.Collapsed
          );
          item.id = `attempt-${workspaceFolder?.uri.toString() || ""}-${element.pipeline.id}-${element.record.id}-${attempt.attempt}`;
          item.contextValue = "azurePipelinePreviousAttempt";
          item.previousAttempt = attempt;
          item.run = element.run;
          item.pipeline = element.pipeline;
          item.workspaceFolder = workspaceFolder;
          return item;
        });
        return [...children, ...previous];
      }

      if (element.artifactsRoot && element.run) {
        const response = await api.listBuildArtifacts(element.run.id);
        return responseItems(response, "artifacts").map(artifact => {
          const item = new vscode.TreeItem(artifact.name, vscode.TreeItemCollapsibleState.None);
          item.id = `artifact-${workspaceFolder?.uri.toString() || ""}-${element.pipeline.id}-${element.run.id}-${artifact.id || artifact.name}`;
          item.contextValue = "azurePipelineArtifact";
          item.iconPath = new vscode.ThemeIcon("archive");
          item.description = artifact.resource?.type;
          item.run = element.run;
          item.pipeline = element.pipeline;
          item.artifact = artifact;
          item.workspaceFolder = workspaceFolder;
          item.command = {
            command: "azure-pipelines.downloadArtifact",
            title: "Download Artifact",
            arguments: [item]
          };
          return item;
        });
      }

      if (element.run && element.pipeline) {
        return this.getRunDetails(api, element.run, element.pipeline);
      }

      if (element.pipeline) {
        const runs = this.currentBranch
          ? (this.branchRuns.get(this.pipelineKey(element.pipeline, workspaceFolder)) || [])
          : responseItems(await api.listRuns(element.pipeline.id), "runs").slice(0, 100);
        return runs.map(run => runNode(run, element.pipeline, workspaceFolder));
      }

      if (element.log) {
        return [];
      }
    } catch (error) {
      return [informationNode("Azure DevOps request failed", error.message)];
    }
    return [];
  }

  async getPipelinesForBranch(api, workspaceFolder) {
    const branch = await this.getBranch(workspaceFolder);
    if (!branch) {
      return [informationNode("No Git branch detected", "Open a Git repository to filter runs by branch")];
    }
    const [buildsResponse, pipelinesResponse] = await Promise.all([
      api.listBuildsForBranch(branch),
      api.listPipelines()
    ]);
    const pipelineIds = new Set(
      responseItems(pipelinesResponse, "pipelines").map(pipeline => Number(pipeline.id))
    );
    const builds = responseItems(buildsResponse, "builds");
    const grouped = new Map();
    for (const build of builds) {
      if (!build.definition?.id || !pipelineIds.has(Number(build.definition.id))) {
        continue;
      }
      const pipeline = {
        id: build.definition.id,
        name: build.definition.name || `Pipeline ${build.definition.id}`
      };
      const run = {
        id: build.id,
        name: build.buildNumber || `Run ${build.id}`,
        state: build.status === "completed" ? "completed" : build.status,
        result: build.result,
        createdDate: build.startTime || build.queueTime,
        resources: {repositories: {self: {refName: build.sourceBranch}}}
      };
      const key = Number(pipeline.id);
      if (!grouped.has(key)) {
        grouped.set(key, {pipeline, runs: []});
      }
      grouped.get(key).runs.push(run);
    }
    const workspaceKey = workspaceFolder?.uri.toString() || "";
    for (const key of this.branchRuns.keys()) {
      if (key.startsWith(`${workspaceKey}:`)) {
        this.branchRuns.delete(key);
      }
    }
    for (const [id, item] of grouped) {
      this.branchRuns.set(
        this.pipelineKey({id}, workspaceFolder),
        item.runs
      );
    }
    return [...grouped.values()].map(item => pipelineNode(
      item.pipeline,
      this.getPinnedIds(),
      workspaceFolder
    ));
  }

  async getTimeline(api, run, timelineId) {
    const key = `${api.organization}/${api.project}:${run.id}:${timelineId || ""}`;
    if (!this.timelines.has(key)) {
      this.timelines.set(key, api.getBuildTimeline(run.id, timelineId).catch(() => undefined));
    }
    return this.timelines.get(key);
  }

  pipelineKey(pipeline, workspaceFolder) {
    return `${workspaceFolder?.uri.toString() || ""}:${pipeline.id}`;
  }

  async getRunDetails(api, run, pipeline) {
    const timeline = await this.getTimeline(api, run);
    const artifacts = artifactsNode(run, pipeline, pipeline.workspaceFolder);
    const records = timeline?.records || [];
    if (records.length) {
      const rootRecords = orderedRecords(records.filter(record => !record.parentId));
      return [
        ...rootRecords.map(record => recordNode(
          record,
          records.some(child => child.parentId === record.id),
          run,
          pipeline,
          undefined,
          pipeline.workspaceFolder
        )),
        artifacts
      ];
    }

    try {
      const logResponse = await api.listPipelineLogs(pipeline.id, run.id);
      const logs = responseItems(logResponse, "logs");
      return [...logs.map(log => {
        const item = new vscode.TreeItem(
          log.name || `Log ${log.id}`,
          vscode.TreeItemCollapsibleState.None
        );
        item.id = `log-${pipeline.id}-${run.id}-${log.id}`;
        item.contextValue = "azurePipelineLog";
        item.iconPath = new vscode.ThemeIcon("output");
        item.description = log.lineCount ? `${log.lineCount} lines` : undefined;
        item.command = {
          command: "azure-pipelines.openLogs",
          title: "Open Logs",
          arguments: [{log, run, pipeline}]
        };
        item.log = log;
        item.run = run;
        item.pipeline = pipeline;
        item.workspaceFolder = pipeline.workspaceFolder;
        return item;
      }), artifacts];
    } catch {
      return [
        informationNode("Run details unavailable", "Timeline and logs are not available for this run"),
        artifacts
      ];
    }
  }
}

class LibraryProvider {
  constructor({getApi, getWorkspaceFolders}) {
    this.getApi = getApi;
    this.getWorkspaceFolders = getWorkspaceFolders;
    this.onDidChangeTreeDataEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  }

  refresh() {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (!element) {
      const folders = this.getWorkspaceFolders?.() || [];
      if (folders.length > 1) {
        const connections = await Promise.all(folders.map(folder => this.getApi(false, folder)));
        const projects = new Set(connections.filter(Boolean).map(api =>
          `${api.organization.toLowerCase()}/${api.project.toLowerCase()}`
        ));
        if (projects.size > 1) {
          return folders.map(workspaceNode);
        }
      }
    }
    const workspaceFolder = element?.workspaceFolder;
    const api = await this.getApi(false, workspaceFolder);
    if (!api) {
      return [informationNode(
        "Configure Azure DevOps",
        workspaceFolder
          ? `No connection detected for ${workspaceFolder.name}`
          : "Organization, project, and authentication required",
        "azure-pipelines.configure",
        workspaceFolder ? [{workspaceFolder}] : undefined
      )];
    }

    try {
      if (!element || element.contextValue === "azurePipelineWorkspace") {
        const [environmentsResult, groupsResult, definitionsResult, approvalsResult] = await Promise.allSettled([
          api.listEnvironments(),
          api.listVariableGroups(),
          api.listBuildDefinitions(),
          api.listPendingApprovals()
        ]);
        return [
          this.groupNode(
            "Environments",
            "environments",
            environmentsResult.status === "fulfilled"
              ? responseItems(environmentsResult.value, "environments")
              : [],
            environmentsResult.status === "rejected" ? environmentsResult.reason.message : undefined,
            workspaceFolder
          ),
          this.groupNode(
            "Variable Groups",
            "variableGroups",
            groupsResult.status === "fulfilled"
              ? responseItems(groupsResult.value, "variableGroups")
              : [],
            groupsResult.status === "rejected" ? groupsResult.reason.message : undefined,
            workspaceFolder
          ),
          this.groupNode(
            "Pipeline Variables",
            "pipelineDefinitions",
            definitionsResult.status === "fulfilled"
              ? responseItems(definitionsResult.value, "definitions")
              : [],
            definitionsResult.status === "rejected" ? definitionsResult.reason.message : undefined,
            workspaceFolder
          ),
          this.groupNode(
            "Pending Approvals",
            "approvals",
            approvalsResult.status === "fulfilled"
              ? responseItems(approvalsResult.value, "approvals")
              : [],
            approvalsResult.status === "rejected" ? approvalsResult.reason.message : undefined,
            workspaceFolder
          )
        ];
      }
      if (element.section === "approvals") {
        if (element.error) {
          return [informationNode("Could not load approvals", element.error)];
        }
        return element.items.map(approval => {
          const buildId = approval.pipeline?.owner?.id;
          const pipelineName = approval.pipeline?.name;
          const item = new vscode.TreeItem(
            pipelineName || approval.instructions || `Approval ${String(approval.id).slice(0, 8)}`,
            vscode.TreeItemCollapsibleState.None
          );
          item.id = `approval-${approval.id}`;
          item.contextValue = "azurePipelineApproval";
          item.description = [
            buildId ? `Run #${buildId}` : "Pending",
            approval.createdOn ? new Date(approval.createdOn).toLocaleString() : ""
          ].filter(Boolean).join(" - ");
          item.tooltip = [
            approval.instructions,
            ...(approval.steps || []).map(step =>
              step.assignedApprover?.displayName
                ? `Approver: ${step.assignedApprover.displayName}`
                : ""
            ),
            approval.minRequiredApprovers
              ? `Minimum approvers: ${approval.minRequiredApprovers}`
              : ""
          ].filter(Boolean).join("\n");
          item.iconPath = new vscode.ThemeIcon("shield");
          item.approval = approval;
          item.workspaceFolder = workspaceFolder;
          if (buildId) {
            item.command = {
              command: "azure-pipelines.openRun",
              title: "Open Related Run",
              arguments: [{
                run: {id: buildId},
                pipeline: {workspaceFolder}
              }]
            };
          }
          return item;
        });
      }
      if (element.section === "environments") {
        if (element.error) {
          return [informationNode("Could not load environments", element.error)];
        }
        return element.items.map(environment => {
          const item = new vscode.TreeItem(environment.name, vscode.TreeItemCollapsibleState.None);
          item.contextValue = "azureEnvironment";
          item.environment = environment;
          item.workspaceFolder = workspaceFolder;
          item.description = environment.description || `Environment ${environment.id}`;
          item.iconPath = new vscode.ThemeIcon("cloud");
          item.tooltip = `Azure Pipelines environment ${environment.name}`;
          item.command = {
            command: "azure-pipelines.openEnvironment",
            title: "Open Environment in Browser",
            arguments: [{environment, workspaceFolder}]
          };
          return item;
        });
      }
      if (element.section === "variableGroups") {
        if (element.error) {
          return [informationNode("Could not load variable groups", element.error)];
        }
        return element.items.map(group => {
          const item = new vscode.TreeItem(
            group.name,
            vscode.TreeItemCollapsibleState.Collapsed
          );
          item.id = `variable-group-${group.id}`;
          item.contextValue = "azureVariableGroup";
          item.description = group.type === "AzureKeyVault" ? "Key Vault" : `${Object.keys(group.variables || {}).length} variables`;
          item.iconPath = new vscode.ThemeIcon(group.type === "AzureKeyVault" ? "key" : "library");
          item.group = group;
          item.workspaceFolder = workspaceFolder;
          return item;
        });
      }
      if (element.section === "pipelineDefinitions") {
        if (element.error) {
          return [informationNode("Could not load pipeline definitions", element.error)];
        }
        return element.items.map(definition => {
          const item = new vscode.TreeItem(
            definition.name || `Pipeline ${definition.id}`,
            vscode.TreeItemCollapsibleState.Collapsed
          );
          item.id = `pipeline-definition-${definition.id}`;
          item.contextValue = "azurePipelineDefinitionVariables";
          item.description = `Definition ${definition.id}`;
          item.iconPath = new vscode.ThemeIcon("symbol-namespace");
          item.definition = definition;
          item.workspaceFolder = workspaceFolder;
          return item;
        });
      }
      if (element.definition) {
        const definition = await api.getBuildDefinition(element.definition.id);
        return Object.entries(definition.variables || {}).map(([name, variable]) => {
          const isSecret = Boolean(variable.isSecret);
          const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
          item.id = `pipeline-variable-${definition.id}-${name}`;
          item.contextValue = isSecret
            ? "azurePipelineVariableSecret"
            : "azurePipelineVariable";
          item.description = isSecret ? "Secret (value hidden)" : (variable.value ?? "");
          item.tooltip = isSecret
            ? "Secret value is hidden by Azure DevOps"
            : `Value: ${variable.value ?? ""}`;
          item.iconPath = new vscode.ThemeIcon(isSecret ? "lock" : "symbol-variable");
          item.definition = definition;
          item.variableName = name;
          item.variable = variable;
          item.workspaceFolder = workspaceFolder;
          return item;
        });
      }
      if (element.group) {
        return Object.entries(element.group.variables || {}).map(([name, variable]) => {
          const isSecret = Boolean(variable.isSecret);
          const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
          item.id = `variable-${element.group.id}-${name}`;
          item.contextValue = isSecret ? "azureLibraryVariableSecret" : "azureLibraryVariable";
          item.description = isSecret ? "Secret (value hidden)" : (variable.value ?? "");
          item.tooltip = isSecret ? "Secret value is hidden by Azure DevOps" : `Value: ${variable.value ?? ""}`;
          item.iconPath = new vscode.ThemeIcon(isSecret ? "lock" : "symbol-variable");
          item.group = element.group;
          item.variableName = name;
          item.variable = variable;
          item.workspaceFolder = workspaceFolder;
          return item;
        });
      }
    } catch (error) {
      return [informationNode("Azure DevOps request failed", error.message)];
    }
    return [];
  }

  groupNode(label, section, items, error, workspaceFolder) {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = section;
    item.section = section;
    item.items = items;
    item.error = error;
    item.workspaceFolder = workspaceFolder;
    item.contextValue = {
      environments: "azureEnvironments",
      variableGroups: "azureVariableGroups",
      pipelineDefinitions: "azurePipelineDefinitions",
      approvals: "azurePipelineApprovals"
    }[section];
    item.iconPath = {
      environments: new vscode.ThemeIcon("cloud"),
      variableGroups: new vscode.ThemeIcon("library"),
      pipelineDefinitions: new vscode.ThemeIcon("symbol-namespace"),
      approvals: new vscode.ThemeIcon("shield")
    }[section];
    item.description = error ? "Unavailable" : String(items.length);
    return item;
  }
}

module.exports = {
  LibraryProvider,
  PipelineProvider,
  informationNode,
  responseItems
};
