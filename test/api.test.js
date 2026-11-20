"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {AzureDevOpsApi} = require("../src/api");
const {normalizeVariables, parseJsonObject, webLogUrl, webRunUrl} = require("../src/helpers");

function createApi(fetchImpl) {
  return new AzureDevOpsApi({
    organization: "contoso",
    project: "My Project",
    token: "test-pat",
    fetchImpl
  });
}

test("project URLs encode organization/project and include API version", () => {
  const api = createApi(async () => ({ok: true, text: async () => '{"value":[]}'}));
  const url = new URL(api.projectUrl("pipelines"));
  assert.equal(url.pathname, "/contoso/My%20Project/_apis/pipelines");
  assert.equal(url.searchParams.get("api-version"), "7.1");
});

test("requests use the PAT as basic-auth password and parse JSON", async () => {
  let request;
  const api = createApi(async (_url, options) => {
    request = options;
    return {ok: true, text: async () => '{"value":[{"id":7}]}'};
  });

  const result = await api.listPipelines();
  assert.deepEqual(result.value, [{id: 7}]);
  assert.equal(request.headers.Authorization, `Basic ${Buffer.from(":test-pat").toString("base64")}`);
});

test("Microsoft authentication sends a bearer token instead of Basic credentials", async () => {
  let request;
  const api = new AzureDevOpsApi({
    organization: "contoso",
    project: "My Project",
    token: "access-token",
    authType: "bearer",
    fetchImpl: async (_url, options) => {
      request = options;
      return {ok: true, text: async () => '{"value":[]}'};
    }
  });

  await api.listPipelines();
  assert.equal(request.headers.Authorization, "Bearer access-token");
});

test("queueing a pipeline builds a branch resource and serializes parameters", async () => {
  let requestBody;
  const api = createApi(async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {ok: true, text: async () => '{"id":12}'};
  });

  await api.runPipeline(4, {
    branch: "main",
    templateParameters: {configuration: "Release"},
    variables: {deploy: {value: "true"}}
  });
  assert.equal(requestBody.resources.repositories.self.refName, "refs/heads/main");
  assert.deepEqual(requestBody.templateParameters, {configuration: "Release"});
  assert.deepEqual(requestBody.variables, {deploy: {value: "true"}});
});

test("current-branch build queries use the Azure DevOps branch filter", async () => {
  let requestUrl;
  const api = createApi(async (url) => {
    requestUrl = new URL(url);
    return {ok: true, text: async () => '{"value":[]}'};
  });

  await api.listBuildsForBranch("feature/my-branch");
  assert.equal(requestUrl.searchParams.get("branchName"), "refs/heads/feature/my-branch");
  assert.equal(requestUrl.searchParams.get("$top"), "100");
});

test("environment create, update, and delete use project-scoped APIs", async () => {
  const requests = [];
  const api = createApi(async (url, options) => {
    requests.push({url: new URL(url), options});
    return {ok: true, text: async () => "{}"};
  });

  await api.createEnvironment({name: "Production"});
  await api.updateEnvironment(6, {name: "Prod"});
  await api.deleteEnvironment(6);
  assert.equal(requests[0].options.method, "POST");
  assert.match(requests[0].url.pathname, /distributedtask\/environments$/);
  assert.equal(requests[1].options.method, "PATCH");
  assert.match(requests[1].url.pathname, /distributedtask\/environments\/6$/);
  assert.equal(requests[2].options.method, "DELETE");
});

test("variable-group creation resolves project metadata and sends project references", async () => {
  const requests = [];
  const api = createApi(async (url, options) => {
    requests.push({url: new URL(url), options});
    return {
      ok: true,
      text: async () => requests.length === 1
        ? '{"id":"project-guid","name":"My Project"}'
        : '{"id":9}'
    };
  });

  await api.createVariableGroup("Build settings", "CI values");
  assert.equal(requests[1].options.method, "POST");
  const body = JSON.parse(requests[1].options.body);
  assert.equal(body.type, "Vsts");
  assert.equal(body.variableGroupProjectReferences[0].projectReference.name, "My Project");
});

test("variable-group updates target the requested group ID", async () => {
  const requests = [];
  const api = createApi(async (url, options) => {
    requests.push({url: new URL(url), options});
    return {
      ok: true,
      text: async () => requests.length === 1
        ? '{"id":"project-guid","name":"My Project"}'
        : "{}"
    };
  });

  await api.updateVariableGroup({id: 17, name: "Updated", type: "Vsts", variables: {}});
  assert.match(requests[1].url.pathname, /variablegroups\/17$/);
  assert.equal(requests[1].options.method, "PUT");
  assert.equal(Object.hasOwn(JSON.parse(requests[1].options.body), "id"), false);
});

test("timeline requests can select a previous attempt timeline", async () => {
  let requestUrl;
  const api = createApi(async url => {
    requestUrl = new URL(url);
    return {ok: true, text: async () => '{"records":[]}'};
  });

  await api.getBuildTimeline(12, "timeline-guid");
  assert.match(requestUrl.pathname, /builds\/12\/timeline\/timeline-guid$/);
});

test("variable-group requests resolve a project name to its ID", async () => {
  const requests = [];
  const api = createApi(async (url, options) => {
    requests.push({url: new URL(url), options});
    const body = requests.length === 1 ? '{"id":"project-guid"}' : '{"value":[]}';
    return {ok: true, text: async () => body};
  });

  await api.listVariableGroups();
  assert.match(requests[0].url.pathname, /_apis\/projects\/My%20Project$/);
  assert.equal(requests[1].url.searchParams.get("projectIds"), "project-guid");
});

test("signed log content is downloaded without forwarding the PAT", async () => {
  const requests = [];
  const api = createApi(async (url, options) => {
    requests.push({url: String(url), options});
    if (requests.length === 1) {
      return {
        ok: true,
        text: async () => '{"signedContent":{"url":"https://logs.example.test/run.txt"}}'
      };
    }
    return {ok: true, text: async () => "step output"};
  });

  assert.equal(await api.getPipelineLog(4, 12, 3), "step output");
  assert.equal(requests[1].options.headers.Authorization, undefined);
});

test("cancel and retry use Azure DevOps build update operations", async () => {
  const requests = [];
  const api = createApi(async (url, options) => {
    requests.push({url: new URL(url), options});
    return {ok: true, text: async () => "{}"};
  });

  await api.cancelRun(12);
  await api.retryRun(13);
  assert.deepEqual(JSON.parse(requests[0].options.body), {id: 12, status: "cancelling"});
  assert.equal(requests[1].url.searchParams.get("retry"), "true");
  assert.deepEqual(JSON.parse(requests[1].options.body), {id: 13});
});

test("API errors contain the status and server message", async () => {
  const api = createApi(async () => ({
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    text: async () => '{"message":"Invalid token"}'
  }));

  await assert.rejects(api.listPipelines(), /Azure DevOps returned 401: Invalid token/);
});

test("JSON input parsing and plain variable normalization are predictable", () => {
  assert.deepEqual(parseJsonObject('{"count":3}', "Parameters"), {count: 3});
  assert.deepEqual(normalizeVariables({enabled: true, name: {value: "build"}}), {
    enabled: {value: "true"},
    name: {value: "build"}
  });
  assert.throws(() => parseJsonObject("[1,2]", "Parameters"), /must be a JSON object/);
});

test("browser links point at the selected Azure DevOps run", () => {
  assert.equal(
    webRunUrl("contoso", "My Project", {id: 42}),
    "https://dev.azure.com/contoso/My%20Project/_build/results?buildId=42&view=results"
  );
});

test("step links open the matching Azure DevOps timeline log", () => {
  const url = new URL(webLogUrl("contoso", "My Project", {id: 42}, {
    id: "task-guid",
    parentId: "job-guid"
  }));
  assert.equal(url.searchParams.get("view"), "logs");
  assert.equal(url.searchParams.get("j"), "job-guid");
  assert.equal(url.searchParams.get("t"), "task-guid");
});
