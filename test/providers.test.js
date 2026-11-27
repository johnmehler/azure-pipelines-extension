"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

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
    this.event = () => ({dispose() {}});
  }

  fire() {}

  dispose() {}
}

const vscode = {
  TreeItem,
  ThemeIcon,
  ThemeColor,
  EventEmitter,
  TreeItemCollapsibleState: {None: 0, Collapsed: 1}
};
const originalLoad = Module._load;
let LibraryProvider;
let PipelineProvider;
let formatDuration;
let recordNode;
Module._load = function(request, parent, isMain) {
  return request === "vscode"
    ? vscode
    : originalLoad.call(this, request, parent, isMain);
};
try {
  ({LibraryProvider, PipelineProvider, formatDuration, recordNode} = require("../src/providers"));
} finally {
  Module._load = originalLoad;
}

function createProvider(api) {
  return new PipelineProvider({
    getApi: async () => api,
    getPinnedIds: () => new Set()
  });
}

test("timeline root records are ordered by execution order", async () => {
  const provider = createProvider({});
  provider.getTimeline = async () => ({
    records: [
      {id: "later", name: "Later stage", order: 2},
      {id: "earlier", name: "Earlier stage", order: 1}
    ]
  });
  const run = {id: 10};
  const pipeline = {id: 4, name: "CI"};

  const records = await provider.getRunDetails({}, run, pipeline);

  assert.deepEqual(records.map(item => item.label), ["Earlier stage", "Later stage", "Artifacts"]);
  assert.equal(records[2].artifactsRoot, true);
});

test("fallback log nodes retain their run, pipeline, and log arguments", async () => {
  const api = {
    listPipelineLogs: async () => ({logs: [{id: 7, name: "Build log"}]})
  };
  const provider = createProvider(api);
  provider.getTimeline = async () => ({records: []});
  const run = {id: 10};
  const pipeline = {id: 4, name: "CI"};

  const [item] = await provider.getRunDetails(api, run, pipeline);

  assert.equal(item.run, run);
  assert.equal(item.pipeline, pipeline);
  assert.deepEqual(item.log, {id: 7, name: "Build log"});
});

test("queued, pending, postponed, and canceling runs use the active icon", async () => {
  const states = ["queued", "pending", "postponed", "canceling"];
  const api = {
    listRuns: async () => ({runs: states.map((state, id) => ({id, state}))})
  };
  const provider = createProvider(api);

  const items = await provider.getChildren({pipeline: {id: 4, name: "CI"}});

  assert.deepEqual(items.map(item => item.iconPath.id), states.map(() => "sync~spin"));
});

test("multi-root providers scope pipeline groups to each workspace folder", async () => {
  const folders = [
    {name: "frontend", uri: {toString: () => "file:///frontend", fsPath: "/frontend"}},
    {name: "backend", uri: {toString: () => "file:///backend", fsPath: "/backend"}}
  ];
  const provider = new PipelineProvider({
    getApi: async () => ({}),
    getPinnedIds: () => new Set(),
    getWorkspaceFolders: () => folders
  });

  const roots = await provider.getChildren();
  assert.deepEqual(roots.map(item => item.label), ["frontend", "backend"]);
  assert.equal(roots[0].workspaceFolder, folders[0]);
});

test("Library section IDs are unique across workspace folders", () => {
  const folders = [
    {name: "frontend", uri: {toString: () => "file:///frontend"}},
    {name: "backend", uri: {toString: () => "file:///backend"}}
  ];
  const provider = new LibraryProvider({getApi: async () => ({})});

  const frontend = provider.groupNode("Environments", "environments", [], undefined, folders[0]);
  const backend = provider.groupNode("Environments", "environments", [], undefined, folders[1]);

  assert.notEqual(frontend.id, backend.id);
});

test("Library resource and variable IDs are unique across workspace folders", async () => {
  const folders = [
    {name: "frontend", uri: {toString: () => "file:///frontend"}},
    {name: "backend", uri: {toString: () => "file:///backend"}}
  ];
  const api = {
    getBuildDefinition: async id => ({
      id,
      variables: {SHARED: {value: "value"}}
    })
  };
  const provider = new LibraryProvider({getApi: async () => api});
  const children = await Promise.all(folders.map(async workspaceFolder => {
    const variableGroups = provider.groupNode("Variable Groups", "variableGroups", [{
      id: 7,
      name: "Shared",
      variables: {SHARED: {value: "value"}}
    }], undefined, workspaceFolder);
    const definitions = provider.groupNode("Pipeline Variables", "pipelineDefinitions", [{
      id: 7,
      name: "Shared"
    }], undefined, workspaceFolder);
    const approvals = provider.groupNode("Pending Approvals", "approvals", [{
      id: "approval-7",
      pipeline: {name: "Shared"}
    }], undefined, workspaceFolder);
    const [group] = await provider.getChildren(variableGroups);
    const [definition] = await provider.getChildren(definitions);
    const [approval] = await provider.getChildren(approvals);
    const [libraryVariable] = await provider.getChildren(group);
    const [pipelineVariable] = await provider.getChildren(definition);
    return {group, definition, approval, libraryVariable, pipelineVariable};
  }));

  for (const key of [
    "group",
    "definition",
    "approval",
    "libraryVariable",
    "pipelineVariable"
  ]) {
    assert.notEqual(children[0][key].id, children[1][key].id, `${key} IDs should be folder-scoped`);
  }
});

test("branch run caches remain isolated when multiple roots are expanded", async () => {
  const folders = [
    {name: "frontend", uri: {toString: () => "file:///frontend", fsPath: "/frontend"}},
    {name: "backend", uri: {toString: () => "file:///backend", fsPath: "/backend"}}
  ];
  const api = {
    organization: "contoso",
    project: "Platform",
    listPipelines: async () => ({value: [{id: 4, name: "CI"}]}),
    listBuildsForBranch: async branch => ({
      value: [{
        id: branch === "frontend" ? 41 : 42,
        definition: {id: 4, name: "CI"},
        status: "completed",
        sourceBranch: `refs/heads/${branch}`
      }]
    })
  };
  const provider = new PipelineProvider({
    getApi: async () => api,
    getPinnedIds: () => new Set(),
    currentBranch: true,
    getBranch: async folder => folder.name,
    getWorkspaceFolders: () => folders
  });

  const [frontendRoot, backendRoot] = await provider.getChildren();
  const [frontendPipeline] = await provider.getChildren(frontendRoot);
  const [backendPipeline] = await provider.getChildren(backendRoot);
  const [frontendRun] = await provider.getChildren(frontendPipeline);
  const [backendRun] = await provider.getChildren(backendPipeline);

  assert.equal(frontendRun.run.id, 41);
  assert.equal(backendRun.run.id, 42);
});

test("timeline cache keys distinguish on-premises servers", async () => {
  const provider = createProvider({});
  const calls = [];
  const run = {id: 12};
  const firstApi = {
    organization: "",
    project: "Build",
    serverUrl: "https://first.example.test/collection",
    getBuildTimeline: async () => {
      calls.push("first");
      return {records: []};
    }
  };
  const secondApi = {
    organization: "",
    project: "Build",
    serverUrl: "https://second.example.test/collection",
    getBuildTimeline: async () => {
      calls.push("second");
      return {records: []};
    }
  };

  await provider.getTimeline(firstApi, run);
  await provider.getTimeline(secondApi, run);

  assert.deepEqual(calls, ["first", "second"]);
});

test("stage and job timeline items expose stage retry context", async () => {
  const api = {listBuildArtifacts: async () => ({value: []})};
  const provider = createProvider(api);
  provider.getTimeline = async () => ({
    records: [
      {id: "stage", name: "Deploy", identifier: "Deploy", type: "Stage", order: 1},
      {id: "job", parentId: "stage", name: "Deploy_job", type: "Job", order: 1}
    ]
  });
  const run = {id: 10, state: "completed"};
  const pipeline = {id: 4, name: "CI"};
  const [stage] = await provider.getRunDetails(api, run, pipeline);
  const [job] = await provider.getChildren(stage);

  assert.equal(stage.contextValue, "azurePipelineStageRetry");
  assert.equal(job.contextValue, "azurePipelineJobRetry");
  assert.equal(job.stageRefName, "Deploy");
});

test("timeline records show their completed durations", () => {
  const pipeline = {id: 4, name: "CI"};
  const run = {id: 10};
  const item = recordNode({
    id: "job",
    name: "Build",
    type: "Job",
    state: "completed",
    startTime: "2026-11-20T12:00:00.000Z",
    finishTime: "2026-11-20T13:02:05.000Z"
  }, false, run, pipeline);

  assert.equal(item.description, "completed - 1h 2m 5s");
  assert.equal(formatDuration(
    "2026-11-20T12:00:00.000Z",
    "2026-11-20T12:00:45.000Z"
  ), "45s");
  assert.equal(formatDuration(
    "2026-11-20T12:00:00.000Z",
    "2026-11-20T13:02:05.000Z"
  ), "1h 2m 5s");
  assert.equal(formatDuration("invalid", "2026-11-20T12:00:45.000Z"), undefined);
  const missingFinish = recordNode({
    id: "done",
    type: "Job",
    state: "completed",
    startTime: "2026-11-20T12:00:00.000Z"
  }, false, run, pipeline);
  assert.equal(missingFinish.description, "completed");
});

test("artifact roots load artifacts and retain run arguments", async () => {
  const artifact = {id: 2, name: "drop", resource: {type: "Container"}};
  const api = {
    listBuildArtifacts: async () => ({value: [artifact]}),
    listPipelineLogs: async () => ({logs: []})
  };
  const provider = createProvider(api);
  provider.getTimeline = async () => ({records: []});
  const run = {id: 10};
  const pipeline = {id: 4, name: "CI"};
  const [artifactsRoot] = await provider.getRunDetails(api, run, pipeline);
  const [item] = await provider.getChildren(artifactsRoot);

  assert.equal(item.artifact, artifact);
  assert.equal(item.run, run);
  assert.equal(item.contextValue, "azurePipelineArtifact");
});

test("Library exposes pending approvals with their related run", async () => {
  const approval = {
    id: "approval-guid",
    pipeline: {name: "Deploy", owner: {id: 42}},
    createdOn: "2026-11-20T12:00:00Z",
    steps: [{assignedApprover: {displayName: "Alex"}}]
  };
  const api = {
    listEnvironments: async () => ({value: []}),
    listVariableGroups: async () => ({value: []}),
    listBuildDefinitions: async () => ({value: []}),
    listPendingApprovals: async () => ({value: [approval]})
  };
  const provider = new LibraryProvider({getApi: async () => api});
  const sections = await provider.getChildren();
  const approvalsSection = sections.find(section => section.section === "approvals");
  const [item] = await provider.getChildren(approvalsSection);

  assert.equal(item.label, "Deploy");
  assert.equal(item.description.startsWith("Run #42"), true);
  assert.equal(item.command.arguments[0].run.id, 42);
  assert.match(item.tooltip, /Approver: Alex/);
});

test("Library lists agent pools and agents with their status", async () => {
  const api = {
    listEnvironments: async () => ({value: []}),
    listVariableGroups: async () => ({value: []}),
    listBuildDefinitions: async () => ({value: []}),
    listPendingApprovals: async () => ({value: []}),
    listAgentPools: async () => ({value: [{id: 8, name: "Linux", isHosted: false}]}),
    listAgents: async () => ({value: [{id: 3, name: "agent-01", status: "online", enabled: true}]})
  };
  const provider = new LibraryProvider({getApi: async () => api});
  const sections = await provider.getChildren();
  const agentPools = sections.find(section => section.section === "agentPools");
  const [pool] = await provider.getChildren(agentPools);
  const [agent] = await provider.getChildren(pool);

  assert.equal(pool.label, "Linux");
  assert.equal(agent.label, "agent-01");
  assert.equal(agent.description, "online");
});

test("current-branch view shows an information node when no builds match the branch", async () => {
  const api = {
    listPipelines: async () => ({value: [{id: 4, name: "CI"}]}),
    listBuildsForBranch: async () => ({value: []})
  };
  const provider = new PipelineProvider({
    getApi: async () => api,
    getPinnedIds: () => new Set(),
    currentBranch: true,
    getBranch: async () => "feature/empty"
  });

  const [item] = await provider.getChildren();
  assert.equal(item.label, "No runs on current branch");
  assert.match(item.description, /feature\/empty/);
});

test("getTimeline does not cache active runs or failed timeline requests", async () => {
  let calls = 0;
  const api = {
    organization: "contoso",
    project: "Platform",
    getBuildTimeline: async () => {
      calls += 1;
      return calls === 1 ? undefined : {records: []};
    }
  };
  const provider = createProvider(api);

  await provider.getTimeline(api, {id: 1, state: "completed"});
  await provider.getTimeline(api, {id: 1, state: "completed"});
  assert.equal(calls, 2, "Failed timeline should not be cached");

  await provider.getTimeline(api, {id: 2, state: "inProgress"});
  await provider.getTimeline(api, {id: 2, state: "inProgress"});
  assert.equal(calls, 4, "Active run timeline should not be cached");
});
