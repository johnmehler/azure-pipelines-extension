"use strict";

const path = require("node:path");
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
  ["always", "always()", "Runs regardless of the outcome of prior work."],
  ["xor", "xor(value1, value2)", "Returns true when exactly one argument is true."]
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

function getTemplateReferenceAt(text, offset) {
  let document;
  try {
    document = YAML.parseDocument(text, {uniqueKeys: false});
  } catch {
    return undefined;
  }
  const references = [];
  const visit = node => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (node.key && node.value) {
      if (
        node.key.value === "template" &&
        typeof node.value.value === "string" &&
        Array.isArray(node.value.range)
      ) {
        const [start, end] = node.value.range;
        if (offset >= start && offset <= end) {
          references.push({path: node.value.value, start, end});
        }
      }
      visit(node.key);
      visit(node.value);
      return;
    }
    if (Array.isArray(node.items)) {
      node.items.forEach(visit);
    }
  };
  visit(document.contents);
  return references.sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
}

function resolveTemplatePaths(templatePath, documentPath, workspaceRoot) {
  if (
    typeof templatePath !== "string" ||
    !templatePath.trim() ||
    /[$*@]/.test(templatePath)
  ) {
    return [];
  }
  const isFileAbsolute = /^[A-Za-z]:[\\/]/.test(templatePath);
  const isRepoRooted = /^[\\/]/.test(templatePath) && !isFileAbsolute;
  const normalizedPath = templatePath.replace(/[\\/]+/g, path.sep);
  if (isFileAbsolute) {
    return [path.resolve(normalizedPath)];
  }
  const root = workspaceRoot || path.dirname(documentPath);
  const candidates = [
    path.resolve(root, normalizedPath.replace(/^[\\/]+/, ""))
  ];
  if (!isRepoRooted) {
    candidates.push(path.resolve(path.dirname(documentPath), normalizedPath));
  }
  return [...new Set(candidates)];
}

function parseTaskReference(reference) {
  const match = typeof reference === "string" && reference.trim().match(/^([^@\s]+)@(\d+)$/);
  return match ? {name: match[1].toLowerCase(), major: Number(match[2])} : undefined;
}

function taskDefinitionForReference(reference, definitions) {
  const parsed = parseTaskReference(reference);
  if (!parsed) {
    return undefined;
  }
  return (definitions || [])
    .filter(definition =>
      typeof definition?.name === "string" &&
      definition.name.toLowerCase() === parsed.name &&
      Number(definition.version?.major) === parsed.major
    )
    .sort((left, right) =>
      Number(right.version?.minor || 0) - Number(left.version?.minor || 0) ||
      Number(right.version?.patch || 0) - Number(left.version?.patch || 0)
    )[0];
}

function getTaskSteps(text) {
  let document;
  try {
    document = YAML.parseDocument(text, {uniqueKeys: false});
  } catch {
    return [];
  }
  const steps = [];
  const visit = node => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node.items)) {
      const taskPair = node.items.find(pair => pair?.key?.value === "task");
      if (taskPair && typeof taskPair.value?.value === "string") {
        steps.push({
          node,
          taskPair,
          inputsPair: node.items.find(pair => pair?.key?.value === "inputs")
        });
      }
      node.items.forEach(visit);
    } else if (node.key) {
      visit(node.key);
      visit(node.value);
    }
  };
  visit(document.contents);
  return steps;
}

function lineIndentAt(text, offset) {
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const beforeOffset = text.slice(lineStart, offset);
  return beforeOffset.match(/^[ \t]*/)[0].length;
}

function taskInputStepAt(text, offset) {
  return getTaskSteps(text).find(candidate => {
    if (!Array.isArray(candidate.inputsPair?.key?.range)) {
      return false;
    }
    const inputs = candidate.inputsPair?.value;
    const range = inputs?.range;
    const inputIndent = lineIndentAt(text, candidate.inputsPair.key.range[0]);
    const currentLineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
    const currentLine = text.slice(currentLineStart, offset);
    const insideInputNode = Array.isArray(range) && offset >= range[0] && offset <= range[1];
    const startingEmptyInputLine = offset >= candidate.inputsPair.key.range[1] &&
      lineIndentAt(text, offset) > inputIndent &&
      /^\s*:\s*$/.test(text.slice(candidate.inputsPair.key.range[1], offset));
    if (!insideInputNode && !startingEmptyInputLine) {
      return false;
    }
    return lineIndentAt(text, offset) > inputIndent &&
      (/^\s*$/.test(currentLine) ||
        inputs?.items?.some(pair =>
          Array.isArray(pair?.key?.range) &&
          offset >= pair.key.range[0] &&
          offset <= pair.key.range[1]
        ));
  });
}

function isTaskInputCompletionPosition(text, offset) {
  return Boolean(taskInputStepAt(text, offset));
}

function getTaskInputCompletions(text, offset, definitions) {
  const step = taskInputStepAt(text, offset);
  if (!step) {
    return [];
  }
  const definition = taskDefinitionForReference(step.taskPair.value.value, definitions);
  if (!definition || !Array.isArray(definition.inputs)) {
    return [];
  }
  const inputs = step.inputsPair.value;
  const inputPairs = Array.isArray(inputs?.items) ? inputs.items : [];
  const currentPair = inputPairs.find(pair =>
    Array.isArray(pair?.key?.range) &&
    offset >= pair.key.range[0] &&
    offset <= pair.key.range[1]
  );
  const currentName = typeof currentPair?.key?.value === "string"
    ? currentPair.key.value.toLowerCase()
    : undefined;
  const existingNames = new Set(inputPairs
    .map(pair => pair?.key?.value)
    .filter(name => typeof name === "string")
    .map(name => name.toLowerCase())
    .filter(name => name !== currentName));
  return definition.inputs
    .filter(input =>
      typeof input?.name === "string" &&
      !existingNames.has(input.name.toLowerCase())
    )
    .map(input => ({
      label: input.name,
      insertText: input.name,
      kind: "property",
      detail: input.required ? "Required task input" : "Task input",
      documentation: input.helpMarkDown || undefined
    }));
}

function getTaskInputDiagnostics(text, definitions) {
  const diagnostics = [];
  for (const step of getTaskSteps(text)) {
    const reference = step.taskPair.value.value;
    const definition = taskDefinitionForReference(reference, definitions);
    if (!definition || !Array.isArray(definition.inputs)) {
      continue;
    }
    const inputMap = step.inputsPair?.value;
    const inputPairs = Array.isArray(inputMap?.items) ? inputMap.items : [];
    const hasDynamicInputs =
      (typeof inputMap?.value === "string" && inputMap.value.includes("${{")) ||
      inputPairs.some(pair => typeof pair?.key?.value === "string" && pair.key.value.includes("$"));
    const inputsByName = new Map();
    for (const input of definition.inputs) {
      if (typeof input?.name !== "string") {
        continue;
      }
      inputsByName.set(input.name.toLowerCase(), input);
      for (const alias of Array.isArray(input.aliases) ? input.aliases : []) {
        if (typeof alias === "string") {
          inputsByName.set(alias.toLowerCase(), input);
        }
      }
    }
    const suppliedNames = new Set();
    for (const pair of inputPairs) {
      const name = pair?.key?.value;
      if (typeof name !== "string" || name.includes("$")) {
        continue;
      }
      const input = inputsByName.get(name.toLowerCase());
      if (!input) {
        if (Array.isArray(pair.key.range)) {
          diagnostics.push({
            start: pair.key.range[0],
            end: pair.key.range[1],
            message: `Unknown input "${name}" for ${reference}.`
          });
        }
        continue;
      }
      suppliedNames.add(input.name.toLowerCase());
      const options = input.options && typeof input.options === "object"
        ? Object.keys(input.options)
        : [];
      const value = pair.value?.value;
      if (
        options.length &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean") &&
        !/[$]/.test(String(value)) &&
        !options.some(option => String(option).toLowerCase() === String(value).toLowerCase()) &&
        Array.isArray(pair.value?.range)
      ) {
        diagnostics.push({
          start: pair.value.range[0],
          end: pair.value.range[1],
          message: `Invalid value "${value}" for task input "${input.name}". Expected one of: ${options.join(", ")}.`
        });
      }
    }
    for (const input of definition.inputs) {
      if (
        input?.required !== true ||
        input.visibleRule ||
        hasDynamicInputs ||
        (input.defaultValue !== undefined && input.defaultValue !== "") ||
        typeof input.name !== "string" ||
        suppliedNames.has(input.name.toLowerCase())
      ) {
        continue;
      }
      diagnostics.push({
        start: step.taskPair.value.range[0],
        end: step.taskPair.value.range[1],
        message: `Required task input "${input.name}" is missing for ${reference}.`
      });
    }
  }
  return diagnostics;
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

function findExpressionEnd(text, bodyStart, close) {
  let quote;
  let nested = 0;
  for (let index = bodyStart; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) {
        if (text[index + 1] === quote) {
          index += 1;
        } else {
          quote = undefined;
        }
      } else if (character === "\\" && index + 1 < text.length) {
        index += 1;
      }
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (close === "]" && character === "[") {
      nested += 1;
      continue;
    }
    if (close === ")" && character === "(") {
      nested += 1;
      continue;
    }
    if ((close === "]" && character === "]") || (close === ")" && character === ")")) {
      if (nested > 0) {
        nested -= 1;
      } else {
        return index;
      }
      continue;
    }
    if (close !== "]" && close !== ")" && text.startsWith(close, index)) {
      return index;
    }
  }
  return -1;
}

function expressionRanges(text) {
  const delimiters = [
    ["${{", "}}", "template"],
    ["$[", "]", "runtime"],
    ["$(", ")", "macro"]
  ];
  const ranges = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    let next;
    for (const [open, close, kind] of delimiters) {
      const start = text.indexOf(open, searchFrom);
      if (start >= 0 && (!next || start < next.start)) {
        next = {start, open, close, kind};
      }
    }
    if (!next) {
      break;
    }
    const bodyStart = next.start + next.open.length;
    const closeStart = findExpressionEnd(text, bodyStart, next.close);
    ranges.push({
      kind: next.kind,
      start: bodyStart,
      end: closeStart < 0 ? text.length : closeStart
    });
    searchFrom = closeStart < 0 ? text.length : closeStart + next.close.length;
  }
  return ranges;
}

function maskStringLiterals(text) {
  const characters = text.split("");
  let quote;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (quote) {
      characters[index] = " ";
      if (character === quote) {
        if (characters[index + 1] === quote) {
          characters[index + 1] = " ";
          index += 1;
        } else {
          quote = undefined;
        }
      } else if (character === "\\" && index + 1 < characters.length) {
        characters[index + 1] = " ";
        index += 1;
      }
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      characters[index] = " ";
    }
  }
  return characters.join("");
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
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = text.indexOf("\n", offset);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const condition = line.match(/^\s*(?:-\s*)?condition\s*:\s*/i);
  const ranges = expressionRanges(text);
  if (condition) {
    const start = lineStart + condition[0].length;
    ranges.push({
      start,
      end: lineEnd < 0 ? text.length : lineEnd
    });
  }
  const range = ranges.find(candidate => offset >= candidate.start && offset <= candidate.end);
  if (!range) {
    return undefined;
  }
  const body = text.slice(range.start, range.end);
  const maskedBody = maskStringLiterals(body);
  const localOffset = offset - range.start;
  const tokens = /[A-Za-z_][A-Za-z0-9_.-]*/g;
  let match;
  let word;
  let tokenEnd;
  while ((match = tokens.exec(maskedBody))) {
    const end = match.index + match[0].length;
    if (localOffset >= match.index && localOffset <= end) {
      word = match[0];
      tokenEnd = end;
      break;
    }
  }
  if (!word) {
    const literalTokens = /[A-Za-z_][A-Za-z0-9_.-]*/g;
    while ((match = literalTokens.exec(body))) {
      const end = match.index + match[0].length;
      if (
        localOffset >= match.index &&
        localOffset <= end &&
        SYSTEM_VARIABLES.includes(match[0])
      ) {
        return {
          title: `${match[0]} variable`,
          body: "A predefined Azure Pipelines variable. Availability depends on the pipeline, stage, job, and expression phase."
        };
      }
    }
    return undefined;
  }
  const fn = FUNCTION_MAP.get(word);
  if (fn && /^\s*\(/.test(body.slice(tokenEnd))) {
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

function tokenizeExpression(body, baseOffset, diagnostics) {
  const tokens = [];
  let index = 0;
  while (index < body.length) {
    const character = body[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "'" || character === "\"") {
      const start = index;
      const quote = character;
      index += 1;
      let closed = false;
      while (index < body.length) {
        if (body[index] === quote) {
          if (quote === "'" && body[index + 1] === quote) {
            index += 2;
          } else {
            index += 1;
            closed = true;
            break;
          }
        } else if (quote === "\"" && body[index] === "\\" && index + 1 < body.length) {
          index += 2;
        } else {
          index += 1;
        }
      }
      if (!closed) {
        diagnostics.push({
          start: baseOffset + start,
          end: baseOffset + body.length,
          message: "Unclosed string literal in Azure Pipelines expression."
        });
      }
      tokens.push({type: "string", value: body.slice(start, index), start, end: index});
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const start = index;
      index += 1;
      while (index < body.length && /[A-Za-z0-9_-]/.test(body[index])) {
        index += 1;
      }
      tokens.push({type: "identifier", value: body.slice(start, index), start, end: index});
      continue;
    }
    if (/\d/.test(character) || ((character === "-" || character === ".") && /\d/.test(body[index + 1] || ""))) {
      const start = index;
      const number = body.slice(index).match(/^-?(?:\d+(?:\.\d*)?|\.\d+)/)[0];
      index += number.length;
      tokens.push({type: "number", value: number, start, end: index});
      continue;
    }
    if ("()[],.".includes(character)) {
      tokens.push({type: character, value: character, start: index, end: index + 1});
      index += 1;
      continue;
    }
    tokens.push({type: "invalid", value: character, start: index, end: index + 1});
    index += 1;
  }
  return tokens;
}

function parseExpressionBody(body, baseOffset) {
  const diagnostics = [];
  const tokens = tokenizeExpression(body, baseOffset, diagnostics);
  let index = 0;
  const peek = () => tokens[index];
  const report = (message, token = peek()) => {
    const start = token ? token.start : body.length;
    const end = token ? token.end : body.length;
    diagnostics.push({start: baseOffset + start, end: baseOffset + end, message});
  };
  const reportUnknownFunction = token => {
    const known = EXPRESSION_FUNCTIONS.some(
      fn => fn.name.toLowerCase() === token.value.toLowerCase()
    );
    if (!known) {
      diagnostics.push({
        start: baseOffset + token.start,
        end: baseOffset + token.end,
        message: `Unknown Azure Pipelines expression function "${token.value}".`
      });
    }
  };
  const synchronize = closing => {
    while (peek() && peek().type !== "," && peek().type !== closing) {
      index += 1;
    }
  };
  let parseExpression;
  const parsePostfix = () => {
    while (peek()) {
      if (peek().type === ".") {
        index += 1;
        if (peek()?.type === "identifier") {
          index += 1;
        } else {
          report("Expected a property name after '.'.");
          return;
        }
      } else if (peek().type === "[") {
        index += 1;
        if (peek()?.type === "]") {
          report("Expected an index expression.");
          index += 1;
          continue;
        }
        parseExpression();
        if (peek()?.type === "]") {
          index += 1;
        } else {
          report("Expected ']' to close the index expression.");
          return;
        }
      } else {
        return;
      }
    }
  };
  const parseCallArguments = () => {
    if (peek()?.type === ")") {
      index += 1;
      return;
    }
    while (peek()) {
      if (peek().type === "," || peek().type === ")") {
        report("Expected an expression argument.");
        if (peek().type === ")") {
          index += 1;
          return;
        }
        index += 1;
        continue;
      }
      parseExpression();
      if (peek()?.type === ",") {
        index += 1;
        if (peek()?.type === ")") {
          report("Expected an expression argument.");
          index += 1;
          return;
        }
        continue;
      }
      if (peek()?.type === ")") {
        index += 1;
        return;
      }
      if (!peek()) {
        report("Expected ')' to close the function call.");
        return;
      }
      report("Expected ',' or ')' after the function argument.");
      synchronize(")");
      if (peek()?.type === ",") {
        index += 1;
      } else if (peek()?.type === ")") {
        index += 1;
        return;
      }
    }
    report("Expected ')' to close the function call.");
  };
  parseExpression = () => {
    const token = peek();
    if (!token) {
      report("Expected an expression.");
      return;
    }
    if (token.type === "identifier") {
      index += 1;
      const keyword = token.value.toLowerCase();
      if ((keyword === "if" || keyword === "elseif") && peek()?.type !== "(") {
        if (!peek()) {
          report(`Expected an expression after "${token.value}".`, token);
        } else {
          parseExpression();
        }
        return;
      }
      if (keyword === "each") {
        if (peek()?.type !== "identifier") {
          report("Expected an iteration variable after 'each'.");
          return;
        }
        index += 1;
        if (peek()?.type !== "identifier" || peek().value.toLowerCase() !== "in") {
          report("Expected 'in' after the iteration variable.");
          return;
        }
        index += 1;
        parseExpression();
        return;
      }
      if (peek()?.type === "(") {
        reportUnknownFunction(token);
        index += 1;
        parseCallArguments();
      }
      parsePostfix();
      return;
    }
    if (token.type === "string" || token.type === "number") {
      index += 1;
      parsePostfix();
      return;
    }
    if (token.type === "(") {
      index += 1;
      if (peek()?.type === ")") {
        report("Expected an expression inside parentheses.");
        index += 1;
        return;
      }
      parseExpression();
      if (peek()?.type === ")") {
        index += 1;
      } else {
        report("Expected ')' to close the parenthesized expression.");
      }
      parsePostfix();
      return;
    }
    if (token.type === "invalid") {
      report(`Unexpected character "${token.value}" in Azure Pipelines expression.`, token);
    } else {
      report(`Unexpected token "${token.value}" in Azure Pipelines expression.`, token);
    }
    index += 1;
  };
  if (!tokens.length) {
    report("Expected an Azure Pipelines expression.");
    return diagnostics;
  }
  parseExpression();
  while (peek()) {
    report(`Unexpected token "${peek().value}" in Azure Pipelines expression.`);
    index += 1;
  }
  return diagnostics;
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
      const bodyStart = start + open.length;
      const end = findExpressionEnd(text, bodyStart, close);
      if (end < 0) {
        diagnostics.push({start, end: start + open.length, message: `Unclosed Azure Pipelines expression; expected "${close}".`});
        break;
      }
      const body = text.slice(bodyStart, end);
      diagnostics.push(...parseExpressionBody(body, bodyStart));
      searchFrom = end + close.length;
    }
  }
  let yamlDocument;
  try {
    yamlDocument = YAML.parseDocument(text, {uniqueKeys: false});
  } catch {
    return diagnostics;
  }
  const visitConditions = node => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node.items)) {
      node.items.forEach(visitConditions);
      return;
    }
    if (node.key?.value === "condition" && typeof node.value?.value === "string") {
      const scalar = node.value;
      if (
        !Array.isArray(scalar.range) ||
        scalar.type === "BLOCK_LITERAL" ||
        scalar.type === "BLOCK_FOLDED" ||
        /\$\{\{|\$\[|\$\(/.test(scalar.value)
      ) {
        return;
      }
      const body = scalar.value.trim();
      if (!body) {
        return;
      }
      const quoteOffset = String(scalar.type || "").startsWith("QUOTE_") ? 1 : 0;
      const leadingWhitespace = scalar.value.length - scalar.value.trimStart().length;
      diagnostics.push(...parseExpressionBody(
        body,
        scalar.range[0] + quoteOffset + leadingWhitespace
      ));
    }
    if (node.key) {
      visitConditions(node.key);
      visitConditions(node.value);
    }
  };
  visitConditions(yamlDocument.contents);
  return diagnostics;
}

module.exports = {
  EXPRESSION_FUNCTIONS,
  getExpressionCompletions,
  getExpressionDiagnostics,
  getExpressionHover,
  getTemplateReferenceAt,
  getTaskInputCompletions,
  getTaskInputDiagnostics,
  isTaskInputCompletionPosition,
  isAzurePipelineDocument,
  getParameterDefinitions,
  parameterPromptKind,
  parsePipelineYaml,
  pipelineNames,
  resolveTemplatePaths,
  typedParameterValue
};
