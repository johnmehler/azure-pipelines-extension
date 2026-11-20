"use strict";

function parseJsonObject(value, title) {
  if (!value?.trim()) {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${title} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${title} must be a JSON object.`);
  }
  return parsed;
}

function normalizeVariables(variables) {
  if (!variables) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(variables).map(([name, value]) => [
    name,
    value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {value: String(value)}
  ]));
}

function webRunUrl(organization, project, run, serverUrl) {
  const base = serverUrl
    ? `${serverUrl.replace(/\/+$/, "")}/${encodeURIComponent(project)}`
    : `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}`;
  return `${base}/_build/results?buildId=${encodeURIComponent(run.id)}&view=results`;
}

function webLogUrl(organization, project, run, record, serverUrl) {
  const url = new URL(webRunUrl(organization, project, run, serverUrl));
  url.searchParams.set("view", "logs");
  if (record?.parentId) {
    url.searchParams.set("j", record.parentId);
  }
  if (record?.id) {
    url.searchParams.set("t", record.id);
  }
  return url.toString();
}

module.exports = {normalizeVariables, parseJsonObject, webLogUrl, webRunUrl};
