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

test("Azure DevOps Server requests use the configured collection URL and API version", () => {
  const api = new AzureDevOpsApi({
    organization: "",
    project: "Build Project",
    serverUrl: "https://ado.example.test/tfs/DefaultCollection/",
    apiVersion: "6.0",
    token: "pat",
    fetchImpl: async () => ({ok: true, text: async () => "{}"})
  });
  const url = new URL(api.projectUrl("pipelines"));
  assert.equal(url.origin, "https://ado.example.test");
  assert.equal(url.pathname, "/tfs/DefaultCollection/Build%20Project/_apis/pipelines");
  assert.equal(url.searchParams.get("api-version"), "6.0");
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

test("pipeline and build-definition lists follow continuation tokens", async () => {
  const requests = [];
  const api = createApi(async url => {
    const requestUrl = new URL(url);
    requests.push(requestUrl);
    const isPipeline = requestUrl.pathname.endsWith("/pipelines");
    const page = requestUrl.searchParams.get("continuationToken") ? 2 : 1;
    const body = isPipeline
      ? {value: [{id: page}]}
      : {value: [{id: page + 10}], ...(page === 1 ? {continuationToken: "definitions-next"} : {})};
    return {
      ok: true,
      headers: new Headers(
        isPipeline && page === 1 ? {"x-ms-continuationtoken": "pipelines-next"} : {}
      ),
      text: async () => JSON.stringify(body)
    };
  });

  const pipelines = await api.listPipelines();
  const definitions = await api.listBuildDefinitions();

  assert.deepEqual(pipelines.value, [{id: 1}, {id: 2}]);
  assert.deepEqual(definitions.value, [{id: 11}, {id: 12}]);
  assert.equal(requests.length, 4);
  assert.equal(requests[1].searchParams.get("continuationToken"), "pipelines-next");
  assert.equal(requests[3].searchParams.get("continuationToken"), "definitions-next");
});

test("task definitions use the organization-scoped Distributed Task endpoint", async () => {
  let requestUrl;
  const api = createApi(async url => {
    requestUrl = new URL(url);
    return {ok: true, text: async () => '{"value":[{"name":"Bash"}]}'};
  });
  const response = await api.listTaskDefinitions();
  assert.equal(requestUrl.pathname, "/contoso/_apis/distributedtask/tasks");
  assert.equal(requestUrl.searchParams.get("api-version"), "7.1");
  assert.deepEqual(response.value, [{name: "Bash"}]);
});

test("secure file uploads send bytes as a raw request body", async () => {
  let request;
  let requestUrl;
  const api = createApi(async (url, options) => {
    requestUrl = new URL(url);
    request = options;
    return {ok: true, text: async () => ""};
  });
  const bytes = Uint8Array.from([1, 2, 3]);
  await api.uploadSecureFile("signing.pfx", bytes);
  assert.equal(request.method, "PUT");
  assert.equal(request.headers["Content-Type"], "application/octet-stream");
  assert.equal(request.body, bytes);
  assert.equal(requestUrl.searchParams.get("name"), "signing.pfx");
});

test("agent pools and service connection APIs use the proper REST routes", async () => {
  const requests = [];
  const api = createApi(async (url, options) => {
    requests.push({url: new URL(url), options});
    return {ok: true, text: async () => "{}"};
  });
  await api.listAgentPools();
  await api.listAgents(9);
  await api.listServiceEndpoints();
  await api.createServiceEndpoint({name: "generic"});
  await api.deleteServiceEndpoint("endpoint-id");
  assert.match(requests[0].url.pathname, /_apis\/distributedtask\/pools$/);
  assert.match(requests[1].url.pathname, /_apis\/distributedtask\/pools\/9\/agents$/);
  assert.match(requests[2].url.pathname, /_apis\/serviceendpoint\/endpoints$/);
  assert.equal(requests[3].options.method, "POST");
  assert.equal(requests[4].options.method, "DELETE");
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
  assert.equal(requestUrl.searchParams.get("queryOrder"), "queueTimeDescending");
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
    return {ok: true, text: async () => "{}"};
  });

  await api.updateVariableGroup({id: 17, name: "Updated", type: "Vsts", variables: {}});
  assert.equal(
    requests[0].url.pathname,
    "/contoso/My%20Project/_apis/distributedtask/variablegroups/17"
  );
  assert.equal(requests[0].options.method, "PUT");
  assert.equal(Object.hasOwn(JSON.parse(requests[0].options.body), "id"), false);
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

test("variable-group requests use the project-scoped API route", async () => {
  const requests = [];
  const api = createApi(async (url, options) => {
    requests.push({url: new URL(url), options});
    return {ok: true, text: async () => '{"value":[]}'};
  });

  await api.listVariableGroups();
  assert.equal(
    requests[0].url.pathname,
    "/contoso/My%20Project/_apis/distributedtask/variablegroups"
  );
  assert.equal(requests[0].url.searchParams.has("projectIds"), false);
  assert.equal(requests[0].url.searchParams.get("api-version"), "7.1");
});

test("variable-group reads and deletes use project-scoped routes", async () => {
  const requests = [];
  const api = createApi(async (url, options) => {
    requests.push({url: new URL(url), options});
    return {ok: true, text: async () => "{}"};
  });

  await api.getVariableGroup(17);
  await api.deleteVariableGroup(17);
  assert.equal(
    requests[0].url.pathname,
    "/contoso/My%20Project/_apis/distributedtask/variablegroups/17"
  );
  assert.equal(requests[0].options.method, "GET");
  assert.equal(
    requests[1].url.pathname,
    "/contoso/My%20Project/_apis/distributedtask/variablegroups/17"
  );
  assert.equal(requests[1].options.method, "DELETE");
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

test("pipeline pause and resume preserve the full build definition", async () => {
  const requests = [];
  const api = createApi(async (url, options) => {
    requests.push({url: new URL(url), options});
    return {
      ok: true,
      text: async () => requests.length === 1
        ? '{"id":14,"name":"CI","revision":4,"queueStatus":"enabled"}'
        : "{}"
    };
  });

  await api.setPipelineQueueStatus(14, "paused");

  assert.match(requests[0].url.pathname, /build\/definitions\/14$/);
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[1].options.method, "PUT");
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    id: 14,
    name: "CI",
    revision: 4,
    queueStatus: "paused"
  });
});

test("runs can be deleted through the build API", async () => {
  let request;
  const api = createApi(async (_url, options) => {
    request = options;
    return {ok: true, text: async () => ""};
  });

  await api.deleteRun(12);

  assert.equal(request.method, "DELETE");
});

test("stage retries and approval decisions use Azure DevOps update APIs", async () => {
  const requests = [];
  const api = createApi(async (url, options) => {
    requests.push({url: new URL(url), options});
    return {ok: true, text: async () => "{}"};
  });

  await api.retryStage(12, "Deploy_Production");
  await api.listPendingApprovals();
  await api.updateApproval("approval-guid", "rejected", "Needs changes");

  assert.match(requests[0].url.pathname, /builds\/12\/stages\/Deploy_Production$/);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    state: "retry",
    forceRetryAllJobs: false
  });
  assert.equal(requests[1].url.searchParams.get("state"), "pending");
  assert.equal(requests[1].url.searchParams.get("$expand"), "steps");
  assert.deepEqual(JSON.parse(requests[2].options.body), [{
    approvalId: "approval-guid",
    status: "rejected",
    comment: "Needs changes"
  }]);
});

test("pipeline definition variables update through the build definitions API", async () => {
  const requests = [];
  const api = createApi(async (url, options) => {
    requests.push({url: new URL(url), options});
    return {ok: true, text: async () => "{}"};
  });

  await api.updateBuildDefinition({
    id: 14,
    revision: 3,
    variables: {configuration: {value: "Release"}}
  });

  assert.match(requests[0].url.pathname, /build\/definitions\/14$/);
  assert.equal(requests[0].options.method, "PUT");
  assert.deepEqual(JSON.parse(requests[0].options.body).variables, {
    configuration: {value: "Release"}
  });
});

test("artifact listing and log tail requests include their query parameters", async () => {
  const requests = [];
  const api = createApi(async url => {
    requests.push(new URL(url));
    return {ok: true, text: async () => '{"value":[]}'};
  });

  await api.listBuildArtifacts(12);
  await api.getBuildLog(12, 7, 41);

  assert.match(requests[0].pathname, /builds\/12\/artifacts$/);
  assert.match(requests[1].pathname, /builds\/12\/logs\/7$/);
  assert.equal(requests[1].searchParams.get("startLine"), "41");
});

test("artifact downloads request a ZIP and return binary content", async () => {
  let requestUrl;
  let requestOptions;
  const api = createApi(async (url, options) => {
    requestUrl = new URL(url);
    requestOptions = options;
    return {
      ok: true,
      arrayBuffer: async () => Uint8Array.from([80, 75, 3, 4]).buffer
    };
  });

  const content = await api.downloadBuildArtifact(12, "drop");

  assert.equal(requestUrl.searchParams.get("artifactName"), "drop");
  assert.equal(requestUrl.searchParams.get("$format"), "zip");
  assert.equal(requestOptions.headers.Authorization, `Basic ${Buffer.from(":test-pat").toString("base64")}`);
  assert.deepEqual([...content], [80, 75, 3, 4]);
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

test("browser links honor an Azure DevOps Server collection URL", () => {
  assert.equal(
    webRunUrl("server", "Build Project", {id: 7}, "https://ado.example.test/tfs/Collection"),
    "https://ado.example.test/tfs/Collection/Build%20Project/_build/results?buildId=7&view=results"
  );
});
