"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {parseAzureDevOpsRemote, parseGitRemotes} = require("../src/git");

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
