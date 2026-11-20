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
let PipelineProvider;
Module._load = function(request, parent, isMain) {
  return request === "vscode"
    ? vscode
    : originalLoad.call(this, request, parent, isMain);
};
try {
  ({PipelineProvider} = require("../src/providers"));
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

  assert.deepEqual(records.map(item => item.label), ["Earlier stage", "Later stage"]);
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
