"use strict";

function parseAzureDevOpsProjectUrl(projectUrl) {
  if (typeof projectUrl !== "string" || !projectUrl.trim()) {
    return undefined;
  }

  let url;
  let path;
  try {
    const input = projectUrl.trim();
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return undefined;
  }

  const host = url.hostname.toLowerCase();
  let organization;
  let project;
  if (host === "dev.azure.com") {
    [organization, project] = path;
  } else if (host.endsWith(".visualstudio.com")) {
    organization = url.hostname.slice(0, -".visualstudio.com".length);
    const projectIndex = path[0]?.toLowerCase() === "defaultcollection" ? 1 : 0;
    project = path[projectIndex];
  }

  return organization && project ? {organization, project} : undefined;
}

function parseAzureDevOpsRemote(remote) {
  if (typeof remote !== "string" || !remote.trim()) {
    return undefined;
  }

  const value = remote.trim();
  let host;
  let serverHost;
  let path;
  try {
    const normalized = /^[^/]+@[^:]+:/.test(value)
      ? `ssh://${value.replace(":", "/")}`
      : value;
    const url = new URL(normalized);
    host = url.hostname.toLowerCase();
    serverHost = url.host;
    path = decodeURIComponent(url.pathname).split("/").filter(Boolean);
  } catch {
    return undefined;
  }

  let organization;
  let project;
  let repository;
  let serverUrl;
  if (host === "dev.azure.com") {
    [organization, project] = path;
    if (path[2]?.toLowerCase() === "_git") {
      repository = path[3];
    }
  } else if (
    host === "ssh.dev.azure.com" ||
    host === "vs-ssh.visualstudio.com" ||
    host.endsWith(".vs-ssh.visualstudio.com")
  ) {
    const v3Index = path.findIndex(segment => segment.toLowerCase() === "v3");
    if (v3Index >= 0) {
      [organization, project, repository] = path.slice(v3Index + 1);
    }
  } else if (host.endsWith(".visualstudio.com")) {
    organization = host.slice(0, -".visualstudio.com".length);
    const collectionIndex = path[0]?.toLowerCase() === "defaultcollection" ? 1 : 0;
    project = path[collectionIndex];
    if (path[collectionIndex + 1]?.toLowerCase() === "_git") {
      repository = path[collectionIndex + 2];
    }
  } else {
    const gitIndex = path.findIndex(segment => segment.toLowerCase() === "_git");
    if (gitIndex >= 2 && path[gitIndex + 1]) {
      organization = path[gitIndex - 2];
      project = path[gitIndex - 1];
      repository = path[gitIndex + 1];
      const collectionPath = path.slice(0, gitIndex - 1)
        .map(segment => encodeURIComponent(segment))
        .join("/");
      serverUrl = `https://${serverHost}/${collectionPath}`;
    }
  }

  if (!organization || !project) {
    return undefined;
  }
  return {organization, project, repository, ...(serverUrl ? {serverUrl} : {})};
}

function parseGitRemotes(output) {
  const rows = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const configEntry = line.match(/^remote\.(.+)\.url\s+(.+)$/i);
    const listingEntry = line.match(/^(\S+)\s+(.+?)\s+\((?:fetch|push)\)$/i);
    const name = configEntry?.[1] || listingEntry?.[1];
    const url = configEntry?.[2] || listingEntry?.[2] || line;
    const remote = parseAzureDevOpsRemote(url);
    if (remote) {
      rows.push({name, remote});
    }
  }

  const originRows = rows.filter(row => row.name === "origin");
  const candidates = originRows.length ? originRows : rows;
  const unique = new Map();
  for (const {remote: candidate} of candidates) {
    const key = `${candidate.serverUrl || candidate.organization}/${candidate.project}`.toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()];
}

module.exports = {parseAzureDevOpsProjectUrl, parseAzureDevOpsRemote, parseGitRemotes};
