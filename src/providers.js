"use strict";

const vscode = require("vscode");

function responseItems(response, key) {
  if (Array.isArray(response)) {
    return response;
  }
  return response?.[key] || response?.value || [];
}

function statusIcon(run) {
  const state = String(run.state || "").toLowerCase();
  const result = String(run.result || "").toLowerCase();
  if (["inprogress", "cancelling", "notstarted"].includes(state)) {
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

function pipelineNode(pipeline, pinnedIds = new Set()) {
  const pinned = pinnedIds.has(Number(pipeline.id));
  const item = new vscode.TreeItem(
    pipeline.name || `Pipeline ${pipeline.id}`,
    vscode.TreeItemCollapsibleState.Collapsed
  );
  item.id = `pipeline-${pipeline.id}`;
  item.contextValue = pinned ? "azurePipelinePinned" : "azurePipeline";
  item.pipeline = pipeline;
  item.description = pipeline.folder && pipeline.folder !== "\\" ? pipeline.folder : undefined;
  item.iconPath = new vscode.ThemeIcon(pinned ? "pin" : "repo");
  item.tooltip = `Pipeline ${pipeline.id}${pipeline.folder ? `\n${pipeline.folder}` : ""}`;
  return item;
}

function runNode(run, pipeline) {
  const active = run.state !== "completed";
  const item = new vscode.TreeItem(runLabel(run), vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `run-${pipeline.id}-${run.id}`;
  item.contextValue = active ? "azurePipelineRunActive" : "azurePipelineRunCompleted";
  item.run = run;
  item.pipeline = pipeline;
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

function informationNode(label, detail, command) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = detail;
  item.iconPath = new vscode.ThemeIcon(command ? "gear" : "info");
  if (command) {
    item.command = {command, title: label};
  }
  return item;
}

function recordNode(record, hasChildren, run, pipeline, timelineId) {
  const item = new vscode.TreeItem(
    record.name || record.type || "Pipeline step",
    hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
  );
  item.id = `timeline-${timelineId || "main"}-${record.id}`;
  item.contextValue = record.log ? "azurePipelineLog" : "azurePipelineTimelineRecord";
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
  return item;
}

class PipelineProvider {
  constructor({getApi, getPinnedIds, currentBranch = false, getBranch}) {
    this.getApi = getApi;
    this.getPinnedIds = getPinnedIds;
    this.currentBranch = currentBranch;
    this.getBranch = getBranch;
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
    const api = await this.getApi(false);
    if (!api) {
      return [informationNode("Configure Azure DevOps", "Organization, project, and authentication required", "azure-pipelines.configure")];
    }

    try {
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
              element.previousAttempt.timelineId
            )]
          : [];
      }

      if (element.record && element.run && element.pipeline) {
        const timeline = await this.getTimeline(api, element.run, element.timelineId);
        const children = (timeline?.records || [])
          .filter(record => record.parentId === element.record.id)
          .map(record => recordNode(
            record,
            (timeline.records || []).some(child => child.parentId === record.id),
            element.run,
            element.pipeline,
            element.timelineId
          ));
        const previous = (element.record.previousAttempts || []).map(attempt => {
          const item = new vscode.TreeItem(
            `Previous attempt ${attempt.attempt}`,
            vscode.TreeItemCollapsibleState.Collapsed
          );
          item.id = `attempt-${element.record.id}-${attempt.attempt}`;
          item.contextValue = "azurePipelinePreviousAttempt";
          item.previousAttempt = attempt;
          item.run = element.run;
          item.pipeline = element.pipeline;
          return item;
        });
        return [...children, ...previous];
      }

      if (element.run && element.pipeline) {
        return this.getRunDetails(api, element.run, element.pipeline);
      }

      if (element.pipeline) {
        const runs = this.currentBranch
          ? (this.branchRuns.get(Number(element.pipeline.id)) || [])
          : responseItems(await api.listRuns(element.pipeline.id), "runs").slice(0, 100);
        return runs.map(run => runNode(run, element.pipeline));
      }

      if (element.log) {
        return [];
      }
    } catch (error) {
      return [informationNode("Azure DevOps request failed", error.message)];
    }
    return [];
  }

  async getPipelinesForBranch(api) {
    const branch = await this.getBranch();
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
    this.branchRuns = new Map([...grouped].map(([id, item]) => [id, item.runs]));
    return [...grouped.values()].map(item => pipelineNode(item.pipeline, this.getPinnedIds()));
  }

  async getTimeline(api, run, timelineId) {
    const key = `${run.id}:${timelineId || ""}`;
    if (!this.timelines.has(key)) {
      this.timelines.set(key, api.getBuildTimeline(run.id, timelineId).catch(() => undefined));
    }
    return this.timelines.get(key);
  }

  async getRunDetails(api, run, pipeline) {
    const timeline = await this.getTimeline(api, run);
    const records = timeline?.records || [];
    if (records.length) {
      const rootRecords = records.filter(record => !record.parentId);
      return rootRecords.map(record => {
        return recordNode(record, records.some(child => child.parentId === record.id), run, pipeline);
      });
    }

    try {
      const logResponse = await api.listPipelineLogs(pipeline.id, run.id);
      const logs = responseItems(logResponse, "logs");
      return logs.map(log => {
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
        return item;
      });
    } catch {
      return [informationNode("Run details unavailable", "Timeline and logs are not available for this run")];
    }
  }
}

class LibraryProvider {
  constructor({getApi}) {
    this.getApi = getApi;
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
    const api = await this.getApi(false);
    if (!api) {
      return [informationNode("Configure Azure DevOps", "Organization, project, and authentication required", "azure-pipelines.configure")];
    }

    try {
      if (!element) {
        const [environmentsResult, groupsResult] = await Promise.allSettled([
          api.listEnvironments(),
          api.listVariableGroups()
        ]);
        return [
          this.groupNode(
            "Environments",
            "environments",
            environmentsResult.status === "fulfilled"
              ? responseItems(environmentsResult.value, "environments")
              : [],
            environmentsResult.status === "rejected" ? environmentsResult.reason.message : undefined
          ),
          this.groupNode(
            "Variable Groups",
            "variableGroups",
            groupsResult.status === "fulfilled"
              ? responseItems(groupsResult.value, "variableGroups")
              : [],
            groupsResult.status === "rejected" ? groupsResult.reason.message : undefined
          )
        ];
      }
      if (element.section === "environments") {
        if (element.error) {
          return [informationNode("Could not load environments", element.error)];
        }
        return element.items.map(environment => {
          const item = new vscode.TreeItem(environment.name, vscode.TreeItemCollapsibleState.None);
          item.contextValue = "azureEnvironment";
          item.environment = environment;
          item.description = environment.description || `Environment ${environment.id}`;
          item.iconPath = new vscode.ThemeIcon("cloud");
          item.tooltip = `Azure Pipelines environment ${environment.name}`;
          item.command = {
            command: "azure-pipelines.openEnvironment",
            title: "Open Environment in Browser",
            arguments: [{environment}]
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
          return item;
        });
      }
    } catch (error) {
      return [informationNode("Azure DevOps request failed", error.message)];
    }
    return [];
  }

  groupNode(label, section, items, error) {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = section;
    item.section = section;
    item.items = items;
    item.error = error;
    item.contextValue = section === "environments" ? "azureEnvironments" : "azureVariableGroups";
    item.iconPath = new vscode.ThemeIcon(section === "environments" ? "cloud" : "library");
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
