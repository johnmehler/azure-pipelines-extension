"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const {
  getExpressionCompletions,
  getExpressionDiagnostics,
  getExpressionHover,
  getAzureYamlCompletions,
  getPipelineResourceDiagnostics,
  addVariableGroupReference,
  getScheduleDiagnostics,
  getScheduleInlayHints,
  getTemplateReferenceAt,
  getTemplateParameterCompletions,
  getTemplateParameterDiagnostics,
  getTemplateParameterTemplateAt,
  getTemplateReferences,
  getTaskHover,
  getTaskInputCompletions,
  getTaskInputDiagnostics,
  getTaskReferenceCompletions,
  getTaskReferenceDiagnostics,
  isTemplateParameterCompletionPosition,
  getParameterDefinitions,
  isAzurePipelineDocument,
  isTaskInputCompletionPosition,
  parameterPromptKind,
  parsePipelineYaml,
  parseTemplateReference,
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

test("completes declared task output variables", () => {
  const source = [
    "jobs:",
    "- job: Build",
    "  steps:",
    "  - task: Publish@1",
    "    name: publish",
    "condition: ${{ eq(dependencies.Build.outputs['publish.Art }}"
  ].join("\n");
  const definitions = [{
    name: "Publish",
    version: {major: 1, minor: 0},
    outputVariables: [{name: "ArtifactId"}, {name: "PackageName"}]
  }];
  const offset = source.indexOf("publish.Art") + "publish.Art".length;
  assert.ok(getExpressionCompletions(source, offset, definitions)
    .some(item => item.label === "publish.ArtifactId"));
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
  const templateDirectives = [
    "parameters:",
    "- name: pairs",
    "  type: object",
    "variables:",
    "  nested: \"${{ and(eq(variables['Build.SourceBranch'], 'refs/heads/main'), not(failed())) }}\"",
    "  conditional: \"${{ if eq(variables['Build.SourceBranch'], 'main') }}\"",
    "  loop: \"${{ each pair in parameters.pairs }}\"",
    "  insert: \"${{ insert }}\""
  ].join("\n");
  assert.deepEqual(getExpressionDiagnostics(templateDirectives), []);

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

test("completes, documents, and validates task name and major-version references", () => {
  const definitions = [
    {name: "Bash", friendlyName: "Bash", version: {major: 3, minor: 2}, description: "Runs scripts."},
    {name: "Bash", version: {major: 4, minor: 1}},
    {name: "CopyFiles", version: {major: 2, minor: 0}}
  ];
  const source = "steps:\n- task: Bash@3";
  assert.deepEqual(
    getTaskReferenceCompletions("steps:\n- task: ", 15, definitions).map(item => item.label),
    ["Bash@4", "Bash@3", "CopyFiles@2"]
  );
  assert.equal(getTaskHover(source, source.indexOf("Bash") + 1, definitions).title, "Bash@3");
  const unknown = "steps:\n- task: Bash@9";
  assert.match(getTaskReferenceDiagnostics(unknown, definitions)[0].message, /available major versions: 3, 4/);
  assert.equal(getTaskReferenceDiagnostics(source, definitions).length, 0);
});

test("completes and validates template parameters from the referenced template", () => {
  const source = [
    "steps:",
    "- template: templates/build.yml@shared",
    "  parameters:",
    "    mode: rel"
  ].join("\n");
  const template = [
    "parameters:",
    "- name: mode",
    "  type: string",
    "  values: [debug, release]",
    "- name: target",
    "  type: string"
  ].join("\n");
  const completionSource = [
    "steps:",
    "- template: templates/build.yml@shared",
    "  parameters:",
    "    mo"
  ].join("\n");
  const offset = completionSource.length;
  assert.equal(isTemplateParameterCompletionPosition(completionSource, offset), true);
  assert.equal(getTemplateParameterTemplateAt(completionSource, offset), "templates/build.yml@shared");
  assert.equal(parseTemplateReference("templates/build.yml@shared").repository, "shared");
  assert.equal(getTemplateReferences(source)[0].path, "templates/build.yml@shared");
  assert.deepEqual(
    getTemplateParameterCompletions(completionSource, offset, template).map(item => item.label),
    ["mode"]
  );
  const diagnostics = getTemplateParameterDiagnostics(source, template);
  assert.equal(diagnostics.length, 2);
  assert.match(diagnostics[0].message, /Invalid value/);
  assert.match(diagnostics[1].message, /Required template parameter "target"/);
});

test("validates cron schedules and provides UTC schedule hints", () => {
  const source = [
    "schedules:",
    "- cron: '0 3 * * 1-5'",
    "  displayName: Weekday build",
    "  branches:",
    "    include: [main]"
  ].join("\n");
  assert.deepEqual(getScheduleDiagnostics(source), []);
  assert.equal(getScheduleInlayHints(source)[0].label, "Weekdays at 03:00 UTC");
  const invalid = "schedules:\n- cron: '90 25 * * *'";
  assert.match(getScheduleDiagnostics(invalid)[0].message, /out of range/);
});

test("completes and validates Azure agent pools and environments", () => {
  const poolSource = "jobs:\n- job: build\n  pool:\n    name: ";
  assert.deepEqual(
    getAzureYamlCompletions(poolSource, poolSource.length, {
      pools: [{name: "Linux"}]
    }).map(item => item.label),
    ["Linux"]
  );
  const environmentSource = "jobs:\n- deployment: deploy\n  environment: ";
  assert.deepEqual(
    getAzureYamlCompletions(environmentSource, environmentSource.length, {
      environments: [{name: "Production"}]
    }).map(item => item.label),
    ["Production"]
  );
  const diagnostics = getPipelineResourceDiagnostics([
    "jobs:",
    "- deployment: deploy",
    "  environment: Missing",
    "  pool:",
    "    name: MissingPool",
    "    vmImage: made-up"
  ].join("\n"), {
    environments: ["Production"],
    pools: ["Linux"]
  });
  assert.equal(diagnostics.length, 3);

  const validResources = [
    "pool: ubuntu-latest",
    "environment:",
    "  name: Production"
  ].join("\n");
  assert.deepEqual(getPipelineResourceDiagnostics(validResources, {
    pools: ["Linux"],
    environments: ["Production"]
  }), []);
  const missingObjectEnvironment = [
    "jobs:",
    "- deployment: deploy",
    "  environment:",
    "    name: Missing",
    "  pool: ubuntu-latest"
  ].join("\n");
  assert.match(
    getPipelineResourceDiagnostics(missingObjectEnvironment, {
      pools: ["Linux"],
      environments: ["Production"]
    })[0].message,
    /Unknown Azure Pipelines environment "Missing"/
  );
});

test("reports function arity and statically invalid parameter references", () => {
  const text = [
    "parameters:",
    "- name: configuration",
    "  type: string",
    "condition: ${{ and(eq(true), eq(parameters.unknown, 'x'), succeeded(true)) }}"
  ].join("\n");
  const messages = getExpressionDiagnostics(text).map(item => item.message);
  assert.ok(messages.some(message => /eq.*expects 2 arguments/.test(message)));
  assert.ok(messages.some(message => /Unknown pipeline parameter "unknown"/.test(message)));
  assert.ok(messages.some(message => /succeeded.*expects 0 arguments/.test(message)));
});

test("adds a variable group to an Azure Pipelines YAML file", () => {
  const result = addVariableGroupReference("trigger: none\n", "Shared");
  assert.equal(result.added, true);
  assert.deepEqual(parsePipelineYaml(result.text).variables, [{group: "Shared"}]);
});

test("appends variable groups and avoids duplicate references", () => {
  const source = [
    "variables:",
    "- name: configuration",
    "  value: Release"
  ].join("\n");
  const result = addVariableGroupReference(source, "Shared");
  assert.equal(result.added, true);
  assert.deepEqual(parsePipelineYaml(result.text).variables, [
    {name: "configuration", value: "Release"},
    {group: "Shared"}
  ]);

  const duplicate = addVariableGroupReference(result.text, "shared");
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.text, result.text);
});

test("converts a variables mapping to a list when adding a variable group", () => {
  const result = addVariableGroupReference("variables:\n  configuration: Release\n", "Shared");
  assert.deepEqual(parsePipelineYaml(result.text).variables, [
    {name: "configuration", value: "Release"},
    {group: "Shared"}
  ]);
});

test("does not rewrite unsupported or invalid pipeline YAML", () => {
  assert.throws(
    () => addVariableGroupReference("variables: [\n", "Shared"),
    /Could not parse pipeline YAML/
  );
  assert.throws(
    () => addVariableGroupReference("variables:\n  settings:\n    mode: release\n", "Shared"),
    /non-scalar value/
  );
});
