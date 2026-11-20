"use strict";

const YAML = require("yaml");

const EXPRESSION_FUNCTIONS = [
  ["and", "and(value1, value2, ...)", "Returns true when all arguments are true."],
  ["coalesce", "coalesce(value1, value2, ...)", "Returns the first non-empty, non-null string."],
  ["contains", "contains(container, item)", "Tests whether a string or array contains a value."],
  ["containsValue", "containsValue(objectOrArray, value)", "Tests object or array values for a match."],
  ["convertToJson", "convertToJson(value)", "Converts an object to a JSON string."],
  ["counter", "counter(prefix, seed)", "Returns a pipeline counter value."],
  ["endsWith", "endsWith(value, suffix)", "Tests whether a string ends with a suffix."],
  ["eq", "eq(left, right)", "Returns true when values are equal."],
  ["format", "format(formatString, ...)", "Formats a string using the supplied arguments."],
  ["ge", "ge(left, right)", "Returns true when the left value is greater than or equal to the right."],
  ["gt", "gt(left, right)", "Returns true when the left value is greater than the right."],
  ["iif", "iif(condition, trueValue, falseValue)", "Returns a value based on a condition."],
  ["in", "in(value, value1, value2, ...)", "Tests whether a value matches any listed value."],
  ["join", "join(separator, array)", "Joins an array into a string."],
  ["le", "le(left, right)", "Returns true when the left value is less than or equal to the right."],
  ["length", "length(value)", "Returns the number of items in a string or array."],
  ["lower", "lower(value)", "Converts a string to lowercase."],
  ["lt", "lt(left, right)", "Returns true when the left value is less than the right."],
  ["ne", "ne(left, right)", "Returns true when values are not equal."],
  ["not", "not(value)", "Negates a boolean value."],
  ["notIn", "notIn(value, value1, value2, ...)", "Tests that a value matches none of the listed values."],
  ["or", "or(value1, value2, ...)", "Returns true when any argument is true."],
  ["replace", "replace(value, old, new)", "Replaces occurrences in a string."],
  ["split", "split(value, separator)", "Splits a string into an array."],
  ["startsWith", "startsWith(value, prefix)", "Tests whether a string starts with a prefix."],
  ["upper", "upper(value)", "Converts a string to uppercase."],
  ["succeeded", "succeeded()", "Tests whether prior pipeline work succeeded."],
  ["failed", "failed()", "Tests whether a prior pipeline step failed."],
  ["canceled", "canceled()", "Tests whether the pipeline was canceled."],
  ["succeededOrFailed", "succeededOrFailed()", "Tests for success or failure, excluding cancellation."],
  ["always", "always()", "Runs regardless of the outcome of prior work."]
].map(([name, signature, description]) => ({name, signature, description}));

const FUNCTION_MAP = new Map(EXPRESSION_FUNCTIONS.map(item => [item.name, item]));
const CONTEXTS = [
  ["variables", "Pipeline and predefined variables."],
  ["parameters", "Compile-time template parameters."],
  ["dependencies", "Outputs and results from dependent jobs or stages."],
  ["stageDependencies", "Outputs from jobs in dependent stages."],
  ["resources", "Pipeline resource metadata."]
];
const SYSTEM_VARIABLES = [
  "Build.BuildId", "Build.BuildNumber", "Build.Reason", "Build.SourceBranch",
  "Build.SourceBranchName", "Build.SourceVersion", "Build.Repository.Name",
  "System.CollectionUri", "System.DefinitionId", "System.JobId", "System.TeamProject"
];

function parsePipelineYaml(text) {
  try {
    return YAML.parse(text, {uniqueKeys: false}) || {};
  } catch {
    return undefined;
  }
}

function isAzurePipelineDocument(uri, text = "") {
  const path = String(uri?.fsPath || uri?.path || "").replace(/\\/g, "/").toLowerCase();
  if (path.includes("/.github/workflows/")) {
    return false;
  }
  if (
    /(^|\/)azure-pipelines(?:\.[^/]*)?\.ya?ml$/.test(path) ||
    /\.azure-pipelines\.ya?ml$/.test(path) ||
    /\/\.azure-pipelines\//.test(path)
  ) {
    return true;
  }
  return /^\s*(?:trigger|pr|pool|stages|jobs|extends|resources|parameters|schedules):/m.test(text);
}

function getParameterDefinitions(text) {
  const document = parsePipelineYaml(text);
  if (!document || !Array.isArray(document.parameters)) {
    return [];
  }
  return document.parameters.filter(parameter => parameter && typeof parameter === "object" && parameter.name);
}

function parameterPromptKind(parameter) {
  if (Array.isArray(parameter.values) && parameter.values.length) {
    return "choice";
  }
  if (parameter.type === "boolean") {
    return "boolean";
  }
  return "input";
}

function typedParameterValue(value, type) {
  if (type === "string" || type === "step" || type === "job" || type === "stage" || type === "deployment") {
    return value;
  }
  if (type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error("Enter a valid number.");
    }
    return number;
  }
  try {
    return YAML.parse(value);
  } catch {
    throw new Error("Enter a valid YAML value for this parameter.");
  }
}

function pipelineNames(text) {
  const root = parsePipelineYaml(text) || {};
  const stages = [];
  const jobs = [];
  const steps = [];
  const jobsByStage = new Map();
  const stepsByJob = new Map();
  const readJobs = (list, stageName) => {
    for (const job of Array.isArray(list) ? list : []) {
      const name = job.job || job.deployment;
      if (name) {
        jobs.push(String(name));
      }
      const jobName = String(name || "");
      const namedSteps = [];
      for (const step of job.steps || []) {
        if (step.name) {
          steps.push(String(step.name));
          namedSteps.push(String(step.name));
        }
      }
      if (jobName) {
        stepsByJob.set(jobName, namedSteps);
        if (stageName) {
          if (!jobsByStage.has(stageName)) {
            jobsByStage.set(stageName, []);
          }
          jobsByStage.get(stageName).push(jobName);
        }
      }
    }
  };
  readJobs(root.jobs);
  for (const stage of root.stages || []) {
    if (stage.stage) {
      stages.push(String(stage.stage));
    }
    readJobs(stage.jobs, String(stage.stage || ""));
  }
  return {root, stages, jobs, steps, jobsByStage, stepsByJob};
}

function expressionAt(text, offset) {
  const before = text.slice(0, offset);
  const candidates = [
    ["${{", "}}", "template"],
    ["$[", "]", "runtime"],
    ["$(", ")", "macro"]
  ];
  let selected;
  for (const [open, close, kind] of candidates) {
    const start = before.lastIndexOf(open);
    const end = before.lastIndexOf(close);
    if (start >= 0 && start > end && (!selected || start > selected.start)) {
      selected = {start: start + open.length, kind};
    }
  }
  if (selected) {
    return {kind: selected.kind, body: before.slice(selected.start)};
  }
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);
  if (/\bcondition\s*:\s*[^#]*$/i.test(line)) {
    return {kind: "condition", body: line.replace(/^.*?\bcondition\s*:\s*/i, "")};
  }
  return undefined;
}

function getExpressionCompletions(text, offset) {
  const expression = expressionAt(text, offset);
  if (!expression) {
    return [];
  }
  const prefix = expression.body;
  const {root, stages, jobs, steps, jobsByStage, stepsByJob} = pipelineNames(text);
  const variables = [];
  if (root.variables && !Array.isArray(root.variables)) {
    variables.push(...Object.keys(root.variables));
  } else if (Array.isArray(root.variables)) {
    variables.push(...root.variables.map(variable => variable?.name).filter(Boolean));
  }
  const parameters = (root.parameters || []).map(parameter => parameter?.name).filter(Boolean);
  if (expression.kind === "macro") {
    return [...new Set([...variables, ...SYSTEM_VARIABLES])]
      .map(label => ({label, insertText: label, detail: "Pipeline variable"}));
  }
  const dependencyOutput = prefix.match(
    /\bdependencies\.([A-Za-z0-9_-]+)\.outputs\[['"]?([^'"]*)?$/
  );
  if (dependencyOutput) {
    const [stepPrefix = ""] = (dependencyOutput[2] || "").split(".");
    return (stepsByJob.get(dependencyOutput[1]) || [])
      .filter(step => step.startsWith(stepPrefix))
      .map(step => ({
        label: `${step}.`,
        insertText: `${step}.`,
        detail: "Named step output variable"
      }));
  }
  const stageOutput = prefix.match(
    /\bstageDependencies\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.outputs\[['"]?([^'"]*)?$/
  );
  if (stageOutput) {
    const [stepPrefix = ""] = (stageOutput[3] || "").split(".");
    return (stepsByJob.get(stageOutput[2]) || [])
      .filter(step => step.startsWith(stepPrefix))
      .map(step => ({
        label: `${step}.`,
        insertText: `${step}.`,
        detail: "Named step output variable"
      }));
  }
  const dependencyProperties = prefix.match(/\bdependencies\.([A-Za-z0-9_-]+)\.$/);
  if (dependencyProperties) {
    return ["result", "outputs"].map(label => ({
      label,
      insertText: label,
      detail: "Dependency property"
    }));
  }
  const stageJobs = prefix.match(/\bstageDependencies\.([A-Za-z0-9_-]+)\.$/);
  if (stageJobs) {
    return (jobsByStage.get(stageJobs[1]) || []).map(label => ({
      label,
      insertText: label,
      detail: "Job in dependent stage"
    }));
  }
  const context = prefix.match(/\b(stageDependencies|dependencies|parameters|variables|resources)\.([A-Za-z0-9_.-]*)$/);
  if (context) {
    const kind = context[1];
    const names = kind === "variables" ? [...new Set([...variables, ...SYSTEM_VARIABLES])]
      : kind === "parameters" ? parameters
        : kind === "dependencies" ? [...new Set([...stages, ...jobs])]
          : kind === "stageDependencies" ? stages
            : ["pipelines", "repositories", "containers", "packages"];
    return names.map(label => ({label, insertText: label, detail: `${kind} context`}));
  }
  if (/\bsteps\.[A-Za-z0-9_-]*$/.test(prefix)) {
    return steps.map(label => ({label, insertText: label, detail: "Named pipeline step"}));
  }
  const candidates = [
    ...EXPRESSION_FUNCTIONS.map(fn => ({
      label: `${fn.name}()`,
      insertText: `${fn.name}()`,
      detail: fn.signature,
      documentation: fn.description
    })),
    ...CONTEXTS.map(([label, detail]) => ({label: `${label}.`, insertText: `${label}.`, detail})),
    {label: "true", insertText: "true", detail: "Boolean literal"},
    {label: "false", insertText: "false", detail: "Boolean literal"},
    {label: "null", insertText: "null", detail: "Null literal"}
  ];
  return candidates;
}

function getExpressionHover(text, offset) {
  const word = text.slice(0, offset).match(/[A-Za-z_][A-Za-z0-9_.-]* *$/)?.[0]?.trim();
  if (!word) {
    return undefined;
  }
  const fn = FUNCTION_MAP.get(word);
  if (fn) {
    return {title: `Azure Pipelines expression: ${fn.signature}`, body: fn.description};
  }
  const context = CONTEXTS.find(([name]) => name === word);
  if (context) {
    return {title: `${word} context`, body: context[1]};
  }
  if (SYSTEM_VARIABLES.includes(word)) {
    return {title: `${word} variable`, body: "A predefined Azure Pipelines variable. Availability depends on the pipeline, stage, job, and expression phase."};
  }
  return undefined;
}

function getExpressionDiagnostics(text) {
  const diagnostics = [];
  const openers = [["${{", "}}"], ["$[", "]"]];
  for (const [open, close] of openers) {
    let searchFrom = 0;
    while (true) {
      const start = text.indexOf(open, searchFrom);
      if (start < 0) {
        break;
      }
      const end = text.indexOf(close, start + open.length);
      if (end < 0) {
        diagnostics.push({start, end: start + open.length, message: `Unclosed Azure Pipelines expression; expected "${close}".`});
        break;
      }
      const bodyStart = start + open.length;
      const body = text.slice(bodyStart, end);
      const calls = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      let match;
      while ((match = calls.exec(body))) {
        if (!FUNCTION_MAP.has(match[1])) {
          const functionStart = bodyStart + match.index;
          diagnostics.push({
            start: functionStart,
            end: functionStart + match[1].length,
            message: `Unknown Azure Pipelines expression function "${match[1]}".`
          });
        }
      }
      searchFrom = end + close.length;
    }
  }
  return diagnostics;
}

module.exports = {
  EXPRESSION_FUNCTIONS,
  getExpressionCompletions,
  getExpressionDiagnostics,
  getExpressionHover,
  isAzurePipelineDocument,
  getParameterDefinitions,
  parameterPromptKind,
  parsePipelineYaml,
  pipelineNames,
  typedParameterValue
};
