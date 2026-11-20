# Azure DevOps Pipelines for VS Code

A VS Code extension for browsing Azure Pipelines, starting and inspecting runs, and editing pipeline YAML.

## Current functionality

- Browse pipelines and their run history in the Activity Bar.
- Detect the Azure DevOps organization, project, and repository from `dev.azure.com`, `visualstudio.com`, and Azure DevOps SSH Git remotes when connection settings are not present.
- Browse multiple workspace folders independently and refresh the Current Branch view when the built-in Git extension reports a branch change.
- View runs associated with the current local Git branch.
- Queue a run on a selected branch with typed parameters discovered from workspace YAML, optional JSON variables, and an opt-in `System.Debug` verbose-logging setting.
- Cancel or retry a run, retry a stage or its failed jobs, approve or reject pending gates, browse run artifacts, and download artifacts as ZIP files.
- Inspect logs in a live-updating viewer with ANSI colors, collapsible `##[group]` sections, in-log search, a timestamp toggle, and links from parsed build errors to local source locations.
- Pin pipelines and see their latest run status from the status bar.
- Create, rename, and delete project environments and variable groups; manage secure files; browse agent pools and agents; and browse, create, and delete generic service connections.
- Use the Microsoft Azure Pipelines language extension for schema/LSP support, with organization task metadata for task-name/version and input completion, validation, and hover. Template parameters are completed and validated for local and `@repository` templates.
- Complete and validate schedule cron expressions, pool names, hosted `vmImage` values, and environment names; cron entries also show UTC inlay hints.
- Complete and validate Azure expression function arity, local parameter/dependency/step references, and selected expression-phase restrictions.
- Validate custom Azure DevOps task metadata files (`task.json`) against Microsoft's task schema.
- Highlight Azure template, runtime, and macro expressions, with expression completions, function hovers, diagnostics, and parameter-aware run prompts when the pipeline YAML is present in the workspace.
- Authenticate with Microsoft account tokens managed by VS Code or a PAT stored in SecretStorage.

This is an initial implementation, not yet a complete feature-for-feature replacement for GitHub Actions. See `FUNCTIONALITY.md` for the reference feature inventory used as the implementation target.
See `PARITY.md` for the Azure equivalent and the remaining platform-specific gaps.

## Setup

VS Code installs the Microsoft Azure Pipelines and Red Hat YAML language extensions as dependencies.

1. Open a workspace containing your Azure Pipelines repository.
2. Open the Azure Pipelines Activity Bar view and choose **Configure Azure DevOps Connection**, or run that command from the Command Palette.
3. Choose Azure DevOps Services or Azure DevOps Server. For Services, paste the full project URL (for example, `https://dev.azure.com/{organization}/{project}`); for Server, enter the collection URL and project. Microsoft account sign-in is available for Services. If your organization's access policy blocks it, choose a PAT instead. PATs are stored in VS Code SecretStorage, not settings or source files.
4. Grant the PAT the Azure DevOps permissions required by the features you plan to use. Build read/execute permissions cover browsing, runs, retries, and artifact downloads; Build definition edit permission is needed for pipeline variables; Environment and Variable Groups manage permissions are needed for library management; pipeline resource approval permission is needed to approve or reject gates.

You can change the organization and project later in VS Code settings. Reconfigure the connection to replace the PAT.
Use **Disconnect Azure DevOps** to clear the configured organization, project, and stored PAT.

## Development

Requires Node.js 20 or newer and VS Code 1.96 or newer.

```sh
npm test
npm run check
```

Open this folder in VS Code and press F5 to launch an Extension Development Host.

## Implementation notes

- Azure DevOps Services and Azure DevOps Server are supported. Server connections use a configurable collection URL, PAT authentication, and configurable REST API version.
- YAML authoring defaults to the published Microsoft pipeline schema. Organization-specific task metadata is available by explicitly downloading your organization's schema.
- Environments support create, rename, delete, and open-in-browser operations. Secure files support upload and delete. Generic service connections support browse, create, and delete; provider-specific endpoint types and environment checks/approvals remain managed in the Azure DevOps web UI.
- Library includes an Agent Pools tree with pool and agent status. Pool permissions and agent administration remain managed in Azure DevOps.
- Variable groups support create, rename, delete, and variable CRUD. Azure Key Vault-linked groups are not edited; Azure DevOps does not reveal stored secret values, so metadata or variable updates preserve masked secrets without resending a value.
- Pipeline definition variables support add, update, and delete operations. Azure DevOps can only retry a job through its containing stage, so the job action retries the failed jobs in that stage rather than isolating one job.
- Queue-time parameters are prompted from the pipeline YAML in the open workspace when available; otherwise the extension accepts a JSON object. Parameters may differ if the selected queue branch has a different YAML definition.
- Azure DevOps has project variable groups rather than GitHub's organization/repository/environment secret scopes. A GitHub Actions job debugger also has no direct Azure Pipelines equivalent.
- The current-branch view lists the latest 100 matching builds. No live Azure DevOps account was available for end-to-end validation.
- Timeline/log availability depends on the pipeline type and the permissions granted to the PAT.
