"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const {
  getExpressionCompletions,
  getExpressionDiagnostics,
  getExpressionHover,
  getTemplateReferenceAt,
  getTaskInputCompletions,
  getTaskInputDiagnostics,
  getParameterDefinitions,
  isAzurePipelineDocument,
  isTaskInputCompletionPosition,
  parameterPromptKind,
  resolveTemplatePaths,
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

test("runtime expressions with bracket indexing close at the outer bracket", () => {
  assert.deepEqual(getExpressionDiagnostics("$[ variables['foo'] ]"), []);
  assert.deepEqual(getExpressionDiagnostics("$[ variables[\"foo\"] ]"), []);
});

test("expression hovers cover the token and only activate inside expressions", () => {
  const expression = "condition: ${{ format('hello') }}";
  const token = expression.indexOf("format");
  assert.match(getExpressionHover(expression, token + 2).title, /format\(/);
  assert.equal(getExpressionHover("This word is format", 16), undefined);
  assert.equal(getExpressionHover("${{ in }}", 5), undefined);
  assert.match(getExpressionHover("${{ variables }}", 7).title, /variables context/);
});

test("diagnostics ignore function-like string literals and recognize xor", () => {
  assert.deepEqual(getExpressionDiagnostics("${{ eq('foo()', xor(true, false)) }}"), []);
});

test("parses nested expression calls and reports malformed arguments and indexes", () => {
  const valid = "${{ and(eq(variables['Build.SourceBranch'], 'refs/heads/main'), not(failed())) }}";
  const templateDirectives = [
    "${{ if eq(variables['Build.SourceBranch'], 'main') }}",
    "${{ each pair in parameters.pairs }}",
    "${{ insert }}"
  ].join("\n");
  assert.deepEqual(getExpressionDiagnostics(`${valid}\n${templateDirectives}`), []);

  const malformed = getExpressionDiagnostics("${{ eq(true, ) }} ${{ variables['x' }}");
  assert.equal(malformed.length, 2);
  assert.match(malformed[0].message, /expression argument/);
  assert.match(malformed[1].message, /Expected '\]'/);

  assert.match(
    getExpressionDiagnostics("${{ eq(true, false }}")[0].message,
    /close the function call/
  );
});

test("parses bare condition expressions and ignores trailing YAML comments", () => {
  const diagnostics = getExpressionDiagnostics([
    "condition: and(succeeded(), eq(variables.Build.SourceBranch, 'main')) # comment",
    "condition: madeUp()",
    "steps:",
    "- script: |",
    "    condition: alsoNotACondition()"
  ].join("\n"));
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /Unknown Azure Pipelines expression function "madeUp"/);
});

test("finds local template references at the cursor", () => {
  const source = [
    "extends:",
    "  template: templates/base.yml",
    "steps:",
    "- template: 'steps/test.yml'"
  ].join("\n");
  const offset = source.indexOf("templates/base.yml") + 5;
  assert.deepEqual(getTemplateReferenceAt(source, offset), {
    path: "templates/base.yml",
    start: source.indexOf("templates/base.yml"),
    end: source.indexOf("templates/base.yml") + "templates/base.yml".length
  });
  assert.equal(getTemplateReferenceAt(source, source.indexOf("extends")), undefined);
});

test("resolves template paths from the workspace root and including file", () => {
  const workspaceRoot = path.resolve("repo");
  const documentPath = path.join(workspaceRoot, "pipelines", "azure-pipelines.yml");
  assert.deepEqual(
    resolveTemplatePaths("templates/build.yml", documentPath, workspaceRoot),
    [
      path.resolve(workspaceRoot, "templates/build.yml"),
      path.resolve(path.dirname(documentPath), "templates/build.yml")
    ]
  );
  assert.deepEqual(
    resolveTemplatePaths("/templates/build.yml", documentPath, workspaceRoot),
    [path.resolve(workspaceRoot, "templates/build.yml")]
  );
  assert.deepEqual(resolveTemplatePaths("${{ parameters.template }}", documentPath, workspaceRoot), []);
  assert.deepEqual(resolveTemplatePaths("build.yml@shared", documentPath, workspaceRoot), []);
});

test("completes unused inputs for the selected task major version", () => {
  const definitions = [
    {
      name: "Bash",
      version: {major: 3, minor: 1, patch: 0},
      inputs: [{name: "oldInput"}]
    },
    {
      name: "Bash",
      version: {major: 3, minor: 2, patch: 0},
      inputs: [
        {name: "targetType", required: true},
        {name: "script", required: true, helpMarkDown: "The script to run."}
      ]
    }
  ];
  const source = [
    "steps:",
    "- task: Bash@3",
    "  inputs:",
    "    targetType: inline",
    "    scr"
  ].join("\n");
  const offset = source.length;
  assert.equal(isTaskInputCompletionPosition(source, offset), true);
  const completions = getTaskInputCompletions(source, offset, definitions);
  assert.deepEqual(completions.map(item => item.label), ["script"]);
  assert.equal(completions[0].documentation, "The script to run.");

  const emptyInputs = "steps:\n- task: Bash@3\n  inputs:\n    ";
  assert.equal(isTaskInputCompletionPosition(emptyInputs, emptyInputs.length), true);
  assert.deepEqual(
    getTaskInputCompletions(emptyInputs, emptyInputs.length, definitions).map(item => item.label),
    ["targetType", "script"]
  );
  const noInputs = "steps:\n- task: Bash@3\n  displayName: build";
  assert.equal(isTaskInputCompletionPosition(noInputs, noInputs.length), false);
});

test("validates unknown, invalid, and missing task inputs", () => {
  const definitions = [{
    name: "Bash",
    version: {major: 3, minor: 2, patch: 0},
    inputs: [
      {name: "targetType", required: true, options: {inline: "Inline", filePath: "File path"}},
      {name: "script", required: true},
      {name: "advanced", required: true, visibleRule: "targetType = filePath"}
    ]
  }];
  const source = [
    "steps:",
    "- task: Bash@3",
    "  inputs:",
    "    targetType: remote",
    "    scrpt: echo hello"
  ].join("\n");
  const diagnostics = getTaskInputDiagnostics(source, definitions);
  assert.equal(diagnostics.length, 3);
  assert.match(diagnostics[0].message, /Invalid value/);
  assert.match(diagnostics[1].message, /Unknown input/);
  assert.match(diagnostics[2].message, /Required task input "script"/);
});
