"use strict";

const API_VERSION = "7.1";

class AzureDevOpsApi {
  constructor({organization, project, token, authType = "pat", fetchImpl = globalThis.fetch}) {
    if (!organization || !project || !token) {
      throw new Error("Azure DevOps organization, project, and an access token are required.");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("This VS Code runtime does not provide fetch().");
    }

    this.organization = organization.trim();
    this.project = project.trim();
    this.token = token;
    this.authType = authType;
    this.fetch = fetchImpl;
    this.projectDetails = undefined;
    this.resolvedProjectId = undefined;
  }

  projectUrl(route, query = {}) {
    const base = `https://dev.azure.com/${encodeURIComponent(this.organization)}/${encodeURIComponent(this.project)}/_apis/${route}`;
    return this.withQuery(base, query);
  }

  organizationUrl(route, query = {}) {
    const base = `https://dev.azure.com/${encodeURIComponent(this.organization)}/_apis/${route}`;
    return this.withQuery(base, query);
  }

  withQuery(base, query) {
    const url = new URL(base);
    for (const [key, value] of Object.entries({...query, "api-version": API_VERSION})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async request(url, {method = "GET", body, accept = "application/json"} = {}) {
    const headers = {Accept: accept};
    headers.Authorization = this.authType === "bearer"
      ? `Bearer ${this.token}`
      : `Basic ${Buffer.from(`:${this.token}`).toString("base64")}`;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await this.fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
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
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  listPipelines() {
    return this.request(this.projectUrl("pipelines", {$top: 200}));
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

  getBuildTimeline(runId, timelineId) {
    const timeline = timelineId ? `/timeline/${encodeURIComponent(timelineId)}` : "/timeline";
    return this.request(this.projectUrl(`build/builds/${encodeURIComponent(runId)}${timeline}`));
  }

  getBuildLog(runId, logId) {
    return this.request(this.projectUrl(
      `build/builds/${encodeURIComponent(runId)}/logs/${encodeURIComponent(logId)}`
    ), {accept: "text/plain"});
  }

  cancelRun(runId) {
    return this.request(this.projectUrl(`build/builds/${encodeURIComponent(runId)}`), {
      method: "PATCH",
      body: {id: Number(runId), status: "cancelling"}
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
