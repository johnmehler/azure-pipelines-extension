"use strict";

const API_VERSION = "7.1";

class AzureDevOpsApi {
  constructor({
    organization,
    project,
    token,
    serverUrl,
    apiVersion = API_VERSION,
    authType = "pat",
    fetchImpl = globalThis.fetch,
    workspaceFolder
  }) {
    if ((!organization && !serverUrl) || !project || !token) {
      throw new Error("An Azure DevOps organization or server URL, project, and access token are required.");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("This VS Code runtime does not provide fetch().");
    }

    this.organization = String(organization || "").trim();
    this.project = project.trim();
    if (serverUrl) {
      const collectionUrl = new URL(serverUrl);
      if (
        collectionUrl.protocol !== "https:" ||
        collectionUrl.username ||
        collectionUrl.password ||
        collectionUrl.search ||
        collectionUrl.hash
      ) {
        throw new Error("Azure DevOps Server collection URL must be an HTTPS URL without credentials, query, or fragment.");
      }
      this.serverUrl = collectionUrl.toString().replace(/\/+$/, "");
    }
    this.apiVersion = String(apiVersion || API_VERSION);
    this.token = token;
    this.authType = authType;
    this.workspaceFolder = workspaceFolder;
    this.fetch = fetchImpl;
    this.projectDetails = undefined;
    this.resolvedProjectId = undefined;
  }

  projectUrl(route, query = {}) {
    const base = `${this.collectionUrl()}/${encodeURIComponent(this.project)}/_apis/${route}`;
    return this.withQuery(base, query);
  }

  organizationUrl(route, query = {}) {
    const base = `${this.collectionUrl()}/_apis/${route}`;
    return this.withQuery(base, query);
  }

  collectionUrl() {
    return this.serverUrl || `https://dev.azure.com/${encodeURIComponent(this.organization)}`;
  }

  withQuery(base, query) {
    const url = new URL(base);
    for (const [key, value] of Object.entries({...query, "api-version": this.apiVersion})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async request(url, {
    method = "GET",
    body,
    rawBody,
    contentType = "application/json",
    accept = "application/json",
    rawResponse = false,
    includeResponse = false
  } = {}) {
    const headers = {Accept: accept};
    headers.Authorization = this.authType === "bearer"
      ? `Bearer ${this.token}`
      : `Basic ${Buffer.from(`:${this.token}`).toString("base64")}`;
    if (body !== undefined || rawBody !== undefined) {
      headers["Content-Type"] = contentType;
    }

    const response = await this.fetch(url, {
      method,
      headers,
      body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed.message || parsed.typeKey || text;
      } catch {
        // Keep the raw response when Azure DevOps does not return JSON.
      }
      throw new Error(`Azure DevOps returned ${response.status}: ${detail || response.statusText}`);
    }
    let result;
    if (!text) {
      result = null;
    } else if (rawResponse) {
      result = text;
    } else {
      try {
        result = JSON.parse(text);
      } catch {
        result = text;
      }
    }
    return includeResponse ? {body: result, headers: response.headers} : result;
  }

  async requestAllPages(route, itemsKey) {
    const items = [];
    const seenTokens = new Set();
    let continuationToken;
    let firstBody;
    let token;
    do {
      const page = await this.request(this.projectUrl(route, {
        $top: 200,
        continuationToken
      }), {includeResponse: true});
      const body = page.body;
      if (firstBody === undefined) {
        firstBody = body;
      }
      const pageItems = Array.isArray(body)
        ? body
        : body?.value || body?.[itemsKey] || [];
      items.push(...pageItems);
      token = page.headers?.get?.("x-ms-continuationtoken") ||
        page.headers?.["x-ms-continuationtoken"] ||
        body?.continuationToken;
      continuationToken = token && !seenTokens.has(token) ? token : undefined;
      if (continuationToken) {
        seenTokens.add(continuationToken);
      }
    } while (continuationToken);

    if (Array.isArray(firstBody)) {
      return items;
    }
    const result = {...(firstBody && typeof firstBody === "object" ? firstBody : {}), value: items};
    if (Array.isArray(result[itemsKey])) {
      result[itemsKey] = items;
    }
    delete result.continuationToken;
    return result;
  }

  listPipelines() {
    return this.requestAllPages("pipelines", "pipelines");
  }

  listBuildDefinitions() {
    return this.requestAllPages("build/definitions", "definitions");
  }

  getBuildDefinition(definitionId) {
    return this.request(this.projectUrl(
      `build/definitions/${encodeURIComponent(definitionId)}`
    ));
  }

  updateBuildDefinition(definition) {
    return this.request(this.projectUrl(
      `build/definitions/${encodeURIComponent(definition.id)}`
    ), {
      method: "PUT",
      body: definition
    });
  }

  async setPipelineQueueStatus(pipelineId, queueStatus, currentDefinition) {
    if (!["enabled", "paused"].includes(queueStatus)) {
      throw new Error("Pipeline queue status must be enabled or paused.");
    }
    const definition = currentDefinition || await this.getBuildDefinition(pipelineId);
    return this.updateBuildDefinition({...definition, queueStatus});
  }

  async getProject() {
    if (!this.projectDetails) {
      this.projectDetails = await this.request(
        this.organizationUrl(`projects/${encodeURIComponent(this.project)}`)
      );
      this.resolvedProjectId = this.projectDetails.id;
    }
    return this.projectDetails;
  }

  async getProjectId() {
    await this.getProject();
    return this.resolvedProjectId;
  }

  getPipeline(pipelineId) {
    return this.request(this.projectUrl(`pipelines/${encodeURIComponent(pipelineId)}`));
  }

  listRuns(pipelineId) {
    return this.request(this.projectUrl(`pipelines/${encodeURIComponent(pipelineId)}/runs`));
  }

  listBuildsForBranch(branch) {
    const branchName = branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
    return this.request(this.projectUrl("build/builds", {
      branchName,
      $top: 100,
      queryOrder: "queueTimeDescending"
    }));
  }

  runPipeline(pipelineId, {branch, templateParameters, variables} = {}) {
    const body = {
      resources: branch
        ? {repositories: {self: {refName: branch.startsWith("refs/") ? branch : `refs/heads/${branch}`}}}
        : undefined,
      templateParameters: templateParameters || undefined,
      variables: variables || undefined
    };
    return this.request(this.projectUrl(`pipelines/${encodeURIComponent(pipelineId)}/runs`), {
      method: "POST",
      body
    });
  }

  listPipelineLogs(pipelineId, runId) {
    return this.request(this.projectUrl(
      `pipelines/${encodeURIComponent(pipelineId)}/runs/${encodeURIComponent(runId)}/logs`
    ));
  }

  async getPipelineLog(pipelineId, runId, logId) {
    const response = await this.request(this.projectUrl(
      `pipelines/${encodeURIComponent(pipelineId)}/runs/${encodeURIComponent(runId)}/logs/${encodeURIComponent(logId)}`,
      {$expand: "signedContent"}
    ), {accept: "text/plain"});
    if (typeof response !== "object" || response === null) {
      return response;
    }
    const signedContent = response.signedContent;
    const signedUrl = typeof signedContent === "string"
      ? signedContent
      : signedContent?.url || response.url;
    if (signedUrl) {
      const url = new URL(signedUrl);
      if (url.protocol !== "https:") {
        throw new Error("Azure DevOps returned a non-HTTPS log URL.");
      }
      const result = await this.fetch(url, {headers: {Accept: "text/plain"}});
      if (!result.ok) {
        throw new Error(`Could not download the log content (${result.status}).`);
      }
      return result.text();
    }
    if (typeof signedContent?.content === "string") {
      return signedContent.content;
    }
    return response;
  }

  getYamlSchema() {
    return this.request(this.organizationUrl("distributedtask/yamlschema"));
  }

  listTaskDefinitions() {
    return this.request(this.organizationUrl("distributedtask/tasks"));
  }

  listAgentPools() {
    return this.request(this.organizationUrl("distributedtask/pools", {
      poolType: "automation",
      actionFilter: "use"
    }));
  }

  listAgents(poolId) {
    return this.request(this.organizationUrl(
      `distributedtask/pools/${encodeURIComponent(poolId)}/agents`,
      {includeAssignedRequest: true}
    ));
  }

  listSecureFiles() {
    return this.request(this.projectUrl("distributedtask/securefiles", {$top: 1000}));
  }

  uploadSecureFile(name, contents) {
    return this.request(this.projectUrl("distributedtask/securefiles", {name}), {
      method: "PUT",
      rawBody: contents,
      contentType: "application/octet-stream"
    });
  }

  deleteSecureFile(fileId) {
    return this.request(this.projectUrl(
      `distributedtask/securefiles/${encodeURIComponent(fileId)}`
    ), {method: "DELETE"});
  }

  listServiceEndpoints() {
    return this.request(this.projectUrl("serviceendpoint/endpoints", {$top: 1000}));
  }

  createServiceEndpoint(endpoint) {
    return this.request(this.projectUrl("serviceendpoint/endpoints"), {
      method: "POST",
      body: endpoint
    });
  }

  updateServiceEndpoint(endpoint) {
    return this.request(this.projectUrl("serviceendpoint/endpoints"), {
      method: "PUT",
      body: endpoint
    });
  }

  deleteServiceEndpoint(endpointId) {
    return this.request(this.projectUrl(
      `serviceendpoint/endpoints/${encodeURIComponent(endpointId)}`
    ), {method: "DELETE"});
  }

  listGitRepositories(project = this.project) {
    const base = `${this.collectionUrl()}/${encodeURIComponent(project)}/_apis/git/repositories`;
    return this.request(this.withQuery(base, {$top: 1000}));
  }

  getGitItem(repositoryId, itemPath, version, versionType = "branch", project = this.project) {
    const base = `${this.collectionUrl()}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/items`;
    return this.request(this.withQuery(base,
      {
        path: itemPath,
        includeContent: true,
        "versionDescriptor.version": version,
        "versionDescriptor.versionType": versionType
      }
    ), {accept: "text/plain", rawResponse: true});
  }

  getBuildTimeline(runId, timelineId) {
    const timeline = timelineId ? `/timeline/${encodeURIComponent(timelineId)}` : "/timeline";
    return this.request(this.projectUrl(`build/builds/${encodeURIComponent(runId)}${timeline}`));
  }

  getBuild(runId) {
    return this.request(this.projectUrl(`build/builds/${encodeURIComponent(runId)}`));
  }

  getBuildLog(runId, logId, startLine) {
    return this.request(this.projectUrl(
      `build/builds/${encodeURIComponent(runId)}/logs/${encodeURIComponent(logId)}`,
      startLine === undefined ? {} : {startLine}
    ), {accept: "text/plain"});
  }

  listBuildArtifacts(runId) {
    return this.request(this.projectUrl(
      `build/builds/${encodeURIComponent(runId)}/artifacts`
    ));
  }

  async downloadBuildArtifact(runId, artifactName) {
    const url = this.projectUrl(
      `build/builds/${encodeURIComponent(runId)}/artifacts`,
      {artifactName, "$format": "zip"}
    );
    const authorization = this.authType === "bearer"
      ? `Bearer ${this.token}`
      : `Basic ${Buffer.from(`:${this.token}`).toString("base64")}`;
    const response = await this.fetch(url, {
      headers: {Authorization: authorization, Accept: "application/zip"}
    });
    if (!response.ok) {
      throw new Error(`Could not download the artifact (${response.status}).`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  retryStage(runId, stageRefName, {forceRetryAllJobs = false} = {}) {
    return this.request(this.projectUrl(
      `build/builds/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageRefName)}`
    ), {
      method: "PATCH",
      body: {state: "retry", forceRetryAllJobs}
    });
  }

  listPendingApprovals() {
    return this.request(this.projectUrl("pipelines/approvals", {
      state: "pending",
      "$expand": "steps"
    }));
  }

  updateApproval(approvalId, status, comment) {
    return this.request(this.projectUrl("pipelines/approvals"), {
      method: "PATCH",
      body: [{
        approvalId,
        status,
        comment: comment || undefined
      }]
    });
  }

  cancelRun(runId) {
    return this.request(this.projectUrl(`build/builds/${encodeURIComponent(runId)}`), {
      method: "PATCH",
      body: {id: Number(runId), status: "cancelling"}
    });
  }

  deleteRun(runId) {
    return this.request(this.projectUrl(`build/builds/${encodeURIComponent(runId)}`), {
      method: "DELETE"
    });
  }

  retryRun(runId) {
    return this.request(this.projectUrl(`build/builds/${encodeURIComponent(runId)}`, {retry: true}), {
      method: "PATCH",
      body: {id: Number(runId)}
    });
  }

  listEnvironments() {
    return this.request(this.projectUrl("distributedtask/environments"));
  }

  createEnvironment(environment) {
    return this.request(this.projectUrl("distributedtask/environments"), {
      method: "POST",
      body: environment
    });
  }

  updateEnvironment(environmentId, environment) {
    return this.request(this.projectUrl(
      `distributedtask/environments/${encodeURIComponent(environmentId)}`
    ), {
      method: "PATCH",
      body: environment
    });
  }

  deleteEnvironment(environmentId) {
    return this.request(this.projectUrl(
      `distributedtask/environments/${encodeURIComponent(environmentId)}`
    ), {method: "DELETE"});
  }

  async createVariableGroup(name, description = "") {
    const project = await this.getProject();
    return this.request(this.organizationUrl("distributedtask/variablegroups"), {
      method: "POST",
      body: {
        name,
        description,
        type: "Vsts",
        variables: {},
        variableGroupProjectReferences: [{
          name,
          description,
          projectReference: {id: project.id, name: project.name}
        }]
      }
    });
  }

  async deleteVariableGroup(groupId) {
    const projectId = await this.getProjectId();
    return this.request(this.organizationUrl(
      `distributedtask/variablegroups/${encodeURIComponent(groupId)}`,
      {projectIds: projectId}
    ), {method: "DELETE"});
  }

  async listVariableGroups() {
    const projectId = await this.getProjectId();
    return this.request(this.organizationUrl("distributedtask/variablegroups", {
      projectIds: projectId
    }));
  }

  async getVariableGroup(groupId) {
    const projectId = await this.getProjectId();
    return this.request(this.organizationUrl(
      `distributedtask/variablegroups/${encodeURIComponent(groupId)}`,
      {projectIds: projectId}
    ));
  }

  async updateVariableGroup(group) {
    const projectId = await this.getProjectId();
    const {id, ...body} = group;
    return this.request(this.organizationUrl(
      `distributedtask/variablegroups/${encodeURIComponent(id)}`,
      {projectIds: projectId}
    ), {
      method: "PUT",
      body
    });
  }
}

module.exports = {API_VERSION, AzureDevOpsApi};
