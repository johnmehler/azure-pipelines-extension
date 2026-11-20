"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {AzureDevOpsApi} = require("../src/api");
const {parseAzureDevOpsProjectUrl, parseAzureDevOpsRemote, parseGitRemotes} = require("../src/git");

test("full Azure DevOps Services project URLs provide organization and project", () => {
  assert.deepEqual(
    parseAzureDevOpsProjectUrl("https://dev.azure.com/contoso/My%20Project/_build?definitionId=42"),
    {organization: "contoso", project: "My Project"}
  );
  assert.deepEqual(
    parseAzureDevOpsProjectUrl("https://contoso.visualstudio.com/DefaultCollection/Platform/_build"),
    {organization: "contoso", project: "Platform"}
  );
  assert.equal(parseAzureDevOpsProjectUrl("https://dev.azure.com/contoso"), undefined);
  assert.equal(parseAzureDevOpsProjectUrl("https://example.com/contoso/Platform"), undefined);
  assert.equal(parseAzureDevOpsProjectUrl("http://dev.azure.com/contoso/Platform"), undefined);
});

test("Azure DevOps HTTPS remotes discover organization, project, and repository", () => {
  assert.deepEqual(
    parseAzureDevOpsRemote("https://john@dev.azure.com/contoso/Platform/_git/web-app"),
    {organization: "contoso", project: "Platform", repository: "web-app"}
  );
});

test("Azure DevOps SSH and legacy visualstudio.com remotes are recognized", () => {
  assert.deepEqual(
    parseAzureDevOpsRemote("git@ssh.dev.azure.com:v3/contoso/Platform/web-app"),
    {organization: "contoso", project: "Platform", repository: "web-app"}
  );
  assert.deepEqual(
    parseAzureDevOpsRemote("contoso@vs-ssh.visualstudio.com:v3/contoso/Platform/web-app"),
    {organization: "contoso", project: "Platform", repository: "web-app"}
  );
  assert.deepEqual(
    parseAzureDevOpsRemote("https://contoso.visualstudio.com/DefaultCollection/Platform/_git/web-app"),
    {organization: "contoso", project: "Platform", repository: "web-app"}
  );
});

test("Azure DevOps Server collection remotes are recognized", () => {
  assert.deepEqual(
    parseAzureDevOpsRemote("https://ado.example.test/tfs/DefaultCollection/Build/_git/agent"),
    {
      organization: "DefaultCollection",
      project: "Build",
      repository: "agent",
      serverUrl: "https://ado.example.test/tfs/DefaultCollection"
    }
  );
});

test("Azure DevOps Server HTTP and SSH remotes produce HTTPS collection URLs", () => {
  const expected = {
    organization: "DefaultCollection",
    project: "Build",
    repository: "agent",
    serverUrl: "https://ado.example.test/tfs/DefaultCollection"
  };
  assert.deepEqual(
    parseAzureDevOpsRemote("http://ado.example.test/tfs/DefaultCollection/Build/_git/agent"),
    expected
  );
  assert.deepEqual(
    parseAzureDevOpsRemote("git@ado.example.test:tfs/DefaultCollection/Build/_git/agent"),
    expected
  );
  assert.doesNotThrow(() => new AzureDevOpsApi({
    ...expected,
    token: "test-pat",
    fetchImpl: async () => ({ok: true, text: async () => "{}"})
  }));
});

test("unrelated remotes are ignored and duplicate projects are collapsed", () => {
  const remotes = parseGitRemotes([
    "origin https://dev.azure.com/contoso/Platform/_git/web-app (fetch)",
    "origin https://dev.azure.com/contoso/Platform/_git/web-app (push)",
    "backup https://github.com/contoso/web-app.git (fetch)"
  ].join("\n"));

  assert.deepEqual(remotes, [
    {organization: "contoso", project: "Platform", repository: "web-app"}
  ]);
});

test("git config remote output discovers the origin remote", () => {
  const remotes = parseGitRemotes([
    "remote.origin.url https://dev.azure.com/contoso/Platform/_git/web-app",
    "remote.upstream.url https://dev.azure.com/other/Shared/_git/web-app"
  ].join("\n"));
  assert.deepEqual(remotes, [
    {organization: "contoso", project: "Platform", repository: "web-app"}
  ]);
});
