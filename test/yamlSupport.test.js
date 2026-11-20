"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getExpressionCompletions,
  getExpressionDiagnostics,
  getExpressionHover,
  getParameterDefinitions,
  isAzurePipelineDocument,
  parameterPromptKind,
  typedParameterValue
} = require("../src/yamlSupport");

test("detects Azure pipeline YAML without claiming GitHub workflow YAML", () => {
  assert.equal(isAzurePipelineDocument({fsPath: "/repo/azure-pipelines.yml"}, ""), true);
  assert.equal(isAzurePipelineDocument({fsPath: "/repo/.github/workflows/ci.yml"}, "jobs:\n"), false);
  assert.equal(isAzurePipelineDocument({fsPath: "/repo/ci.yml"}, "trigger:\n- main"), true);
});

test("reads declared pipeline parameters and their input types", () => {
  const definitions = getParameterDefinitions(`
parameters:
- name: configuration
  type: string
  default: Release
- name: deploy
  type: boolean
- name: region
  type: string
  values: [west, east]
`);
  assert.equal(definitions.length, 3);
  assert.equal(parameterPromptKind(definitions[0]), "input");
  assert.equal(parameterPromptKind(definitions[1]), "boolean");
  assert.equal(parameterPromptKind(definitions[2]), "choice");
  assert.equal(typedParameterValue("4", "number"), 4);
});

test("offers expression completions and documentation", () => {
  const source = "parameters:\n- name: deploy\n  type: boolean\ncondition: ${{ parameters. }}";
  const offset = source.indexOf("parameters.") + "parameters.".length;
  const items = getExpressionCompletions(source, offset);
  assert.ok(items.some(item => item.label === "deploy"));
  assert.match(getExpressionHover("condition: eq(", 13).title, /eq\(left, right\)/);
  const variable = "condition: ${{ variables['Build.SourceBranch'] }}";
  const variableOffset = variable.indexOf("Build.SourceBranch") + "Build.SourceBranch".length;
  assert.match(getExpressionHover(variable, variableOffset).title, /Build\.SourceBranch/);
});

test("completes dependency outputs from named jobs and steps", () => {
  const source = [
    "jobs:",
    "- job: Build",
    "  steps:",
    "  - script: echo ready",
    "    name: SetVersion",
    "condition: ${{ dependencies.Build.outputs['Set }}"
  ].join("\n");
  const offset = source.indexOf("Set }}") + 3;
  const items = getExpressionCompletions(source, offset);
  assert.ok(items.some(item => item.label === "SetVersion."));
});

test("diagnoses unclosed expressions and unknown expression functions", () => {
  const diagnostics = getExpressionDiagnostics("condition: ${{ madeUp() }}\nvariables:\n  x: ${{ eq(true, true) ");
  assert.equal(diagnostics.length, 2);
  assert.match(diagnostics[0].message, /Unknown/);
  assert.match(diagnostics[1].message, /Unclosed/);
});
