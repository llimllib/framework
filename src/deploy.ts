import {exec} from "node:child_process";
import {createHash} from "node:crypto";
import type {Stats} from "node:fs";
import {existsSync} from "node:fs";
import {readFile, stat} from "node:fs/promises";
import {join} from "node:path/posix";
import {promisify} from "node:util";
import slugify from "@sindresorhus/slugify";
import wrapAnsi from "wrap-ansi";
import type {BuildEffects, BuildManifest, BuildOptions} from "./build.js";
import {FileBuildEffects, build} from "./build.js";
import type {ClackEffects} from "./clack.js";
import {commandRequiresAuthenticationMessage} from "./commandInstruction.js";
import {RateLimiter, runAllWithConcurrencyLimit} from "./concurrency.js";
import type {Config} from "./config.js";
import {CliError, isApiError, isEnoent, isHttpError} from "./error.js";
import {visitFiles} from "./files.js";
import type {Logger} from "./logger.js";
import type {AuthEffects} from "./observableApiAuth.js";
import {defaultEffects as defaultAuthEffects, formatUser, loginInner, validWorkspaces} from "./observableApiAuth.js";
import {ObservableApiClient, getObservableUiOrigin} from "./observableApiClient.js";
import type {
  DeployManifestFile,
  GetCurrentUserResponse,
  GetDeployResponse,
  GetProjectResponse,
  WorkspaceResponse
} from "./observableApiClient.js";
import type {ConfigEffects, DeployConfig} from "./observableApiConfig.js";
import {defaultEffects as defaultConfigEffects, getDeployConfig, setDeployConfig} from "./observableApiConfig.js";
import {Telemetry} from "./telemetry.js";
import type {TtyEffects} from "./tty.js";
import {bold, defaultEffects as defaultTtyEffects, faint, inverse, link, underline, yellow} from "./tty.js";

const DEPLOY_POLL_MAX_MS = 1000 * 60 * 5;
const DEPLOY_POLL_INTERVAL_MS = 1000 * 5;
const BUILD_AGE_WARNING_MS = 1000 * 60 * 5;

const OBSERVABLE_UI_ORIGIN = getObservableUiOrigin();

export function formatGitUrl(url: string) {
  return new URL(url).pathname.slice(1).replace(/\.git$/, "");
}

function settingsUrl(deployTarget: DeployTargetInfo) {
  if (deployTarget.create) {
    throw new Error("Incorrect deploy target state");
  }
  return `${OBSERVABLE_UI_ORIGIN}projects/@${deployTarget.workspace.login}/${deployTarget.project.slug}`;
}

/**
 * Returns the ownerName and repoName of the first GitHub remote (HTTPS or SSH)
 * on the current repository, or null.
 */
async function getGitHubRemote() {
  const remotes = (await promisify(exec)("git remote -v")).stdout
    .split("\n")
    .filter((d) => d)
    .map((d) => {
      const [, url] = d.split(/\s/g);
      if (url.startsWith("https://github.com/")) {
        // HTTPS: https://github.com/observablehq/framework.git
        const [ownerName, repoName] = new URL(url).pathname
          .slice(1)
          .replace(/\.git$/, "")
          .split("/");
        return {ownerName, repoName};
      } else if (url.startsWith("git@github.com:")) {
        // SSH: git@github.com:observablehq/framework.git
        const [ownerName, repoName] = url
          .replace(/^git@github.com:/, "")
          .replace(/\.git$/, "")
          .split("/");
        return {ownerName, repoName};
      }
    });
  const remote = remotes.find((d) => d && d.ownerName && d.repoName);
  if (!remote) throw new CliError("No GitHub remote found.");
  return remote ?? null;
}

export interface DeployOptions {
  config: Config;
  deployConfigPath: string | undefined;
  message?: string;
  deployPollInterval?: number;
  force: "build" | "deploy" | null;
  maxConcurrency?: number;
  deployId?: string;
}

export interface DeployEffects extends ConfigEffects, TtyEffects, AuthEffects {
  getDeployConfig: (
    sourceRoot: string,
    deployConfigPath: string | undefined,
    effects: ConfigEffects
  ) => Promise<DeployConfig>;
  setDeployConfig: (
    sourceRoot: string,
    deployConfigPath: string | undefined,
    config: DeployConfig,
    effects: ConfigEffects
  ) => Promise<void>;
  clack: ClackEffects;
  logger: Logger;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  visitFiles: (root: string) => Generator<string>;
  stat: (path: string) => Promise<Stats>;
  build: ({config}: BuildOptions, effects?: BuildEffects) => Promise<void>;
  readCacheFile: (sourceRoot: string, path: string) => Promise<string>;
}

const defaultEffects: DeployEffects = {
  ...defaultConfigEffects,
  ...defaultTtyEffects,
  ...defaultAuthEffects,
  getDeployConfig,
  setDeployConfig,
  logger: console,
  input: process.stdin,
  output: process.stdout,
  visitFiles,
  stat,
  build,
  readCacheFile
};

type DeployTargetInfo =
  | {create: true; workspace: {id: string; login: string}; projectSlug: string; title: string; accessLevel: string}
  | {
      create: false;
      workspace: {id: string; login: string};
      project: GetProjectResponse;
    };

/** Deploy a project to Observable */
export async function deploy(deployOptions: DeployOptions, effects = defaultEffects): Promise<void> {
  Telemetry.record({event: "deploy", step: "start", force: deployOptions.force});
  effects.clack.intro(`${inverse(" observable deploy ")} ${faint(`v${process.env.npm_package_version}`)}`);

  const deployInfo = await new Deployer(deployOptions, effects).deploy();

  effects.clack.outro(`Deployed app now visible at ${link(deployInfo.url)}`);
  Telemetry.record({event: "deploy", step: "finish"});
}

class Deployer {
  private deployOptions: DeployOptions;
  private effects: DeployEffects;
  private apiClient!: ObservableApiClient;
  private currentUser!: GetCurrentUserResponse;

  constructor(deployOptions: DeployOptions, effects = defaultEffects) {
    if (deployOptions.deployConfigPath === "") throw new CliError("Invalid path for --deploy-config");
    this.deployOptions = deployOptions;
    this.effects = effects;
  }

  async deploy(): Promise<GetDeployResponse> {
    await this.setApiClientAndCurrentUser();
    const deployInfo = this.deployOptions.deployId ? await this.continueExistingDeploy() : await this.startNewDeploy();
    return deployInfo;
  }

  private async setApiClientAndCurrentUser() {
    let apiKey = await this.effects.getObservableApiKey(this.effects);
    const apiClient = new ObservableApiClient(
      apiKey ? {apiKey, clack: this.effects.clack} : {clack: this.effects.clack}
    );

    let currentUser: GetCurrentUserResponse | null = null;
    let authError: null | "unauthenticated" | "forbidden" = null;
    try {
      if (apiKey) {
        currentUser = await apiClient.getCurrentUser();
        // List of valid workspaces that can be used to create projects.
        currentUser = {...currentUser, workspaces: validWorkspaces(currentUser.workspaces)};
      }
    } catch (error) {
      if (isHttpError(error)) {
        if (error.statusCode === 401) authError = "unauthenticated";
        else if (error.statusCode === 403) authError = "forbidden";
        else throw error;
      } else {
        throw error;
      }
    }

    if (!currentUser) {
      if (!this.effects.isTty) {
        if (authError === "unauthenticated" || !apiKey) {
          throw new CliError("No authentication provided");
        } else {
          const source =
            apiKey.source == "file"
              ? ` from ${apiKey.filePath}`
              : apiKey.source === "env"
              ? ` from $${apiKey.envVar}`
              : "";
          throw new CliError(`Authentication${source} was rejected by the server: ${authError ?? "unknown error"}`);
        }
      }
      const message =
        authError === "unauthenticated" || authError === null
          ? "You must be logged in to Observable to deploy. Do you want to do that now?"
          : "Your authentication is invalid. Do you want to log in to Observable again?";
      const choice = await this.effects.clack.confirm({
        message,
        active: "Yes, log in",
        inactive: "No, cancel deploy"
      });
      if (!choice) {
        this.effects.clack.outro(yellow("Deploy canceled."));
      }
      if (this.effects.clack.isCancel(choice) || !choice)
        throw new CliError("User canceled deploy", {print: false, exitCode: 0});

      ({currentUser, apiKey} = await loginInner(this.effects, {pollTime: this.deployOptions.deployPollInterval}));
      apiClient.setApiKey(apiKey);
    }

    if (!currentUser) throw new CliError(commandRequiresAuthenticationMessage);

    this.apiClient = apiClient;
    this.currentUser = currentUser;
  }

  private async continueExistingDeploy(): Promise<GetDeployResponse> {
    const {deployId} = this.deployOptions;
    if (!deployId) throw new Error("invalid deploy options");
    await this.checkDeployCreated(deployId);

    const buildFilePaths = await this.getBuildFilePaths();

    await this.uploadFiles(deployId, buildFilePaths);
    await this.markDeployUploaded(deployId);
    const deployInfo = await this.pollForProcessingCompletion(deployId);

    return deployInfo;
  }

  private async cloudBuild(deployTarget: DeployTargetInfo) {
    if (deployTarget.create) {
      throw new Error("Incorrect deploy target state");
    }
    const {deployPollInterval: pollInterval = DEPLOY_POLL_INTERVAL_MS} = this.deployOptions;
    await this.apiClient.postProjectBuild(deployTarget.project.id);
    const spinner = this.effects.clack.spinner();
    spinner.start("Requesting deploy");
    const pollExpiration = Date.now() + DEPLOY_POLL_MAX_MS;
    while (true) {
      if (Date.now() > pollExpiration) {
        spinner.stop("Requesting deploy timed out.");
        throw new CliError("Requesting deploy failed");
      }
      const {latestCreatedDeployId} = await this.apiClient.getProject({
        workspaceLogin: deployTarget.workspace.login,
        projectSlug: deployTarget.project.slug
      });
      if (latestCreatedDeployId !== deployTarget.project.latestCreatedDeployId) {
        spinner.stop(
          `Deploy started. Watch logs: ${link(`${settingsUrl(deployTarget)}/deploys/${latestCreatedDeployId}`)}`
        );
        // latestCreatedDeployId is initially null for a new project, but once
        // it changes to a string it can never change back; since we know it has
        // changed, we assert here that it’s not null
        return latestCreatedDeployId!;
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  // Throws error if local and remote GitHub repos don’t match or are invalid
  private async validateGitHubLink(deployTarget: DeployTargetInfo): Promise<void> {
    if (deployTarget.create) {
      throw new Error("Incorrect deploy target state");
    }
    if (!deployTarget.project.build_environment_id) {
      // TODO: allow setting build environment from CLI
      throw new CliError("No build environment configured.");
    }
    // We only support cloud builds from the root directory so this ignores
    // this.deployOptions.config.root
    const isGit = existsSync(".git");
    if (!isGit) throw new CliError("Not at root of a git repository.");

    const {ownerName, repoName} = await getGitHubRemote();
    const branch = (await promisify(exec)("git rev-parse --abbrev-ref HEAD")).stdout;
    let localRepo = await this.apiClient.getGitHubRepository({ownerName, repoName});

    // If a source repository has already been configured, check that it’s
    // accessible and matches the local repository and branch.
    // TODO: validate local/remote refs match, "Your branch is up to date",
    // and "nothing to commit, working tree clean".
    if (deployTarget.project.source) {
      if (localRepo && deployTarget.project.source.provider_id !== localRepo.provider_id) {
        throw new CliError(
          `Configured repository does not match local repository; check build settings on ${link(
            `${settingsUrl(deployTarget)}/settings`
          )}`
        );
      }
      if (localRepo && deployTarget.project.source.branch !== branch) {
        throw new CliError(
          `Configured branch does not match local branch; check build settings on ${link(
            `${settingsUrl(deployTarget)}/settings`
          )}`
        );
      }
      const remoteAuthedRepo = await this.apiClient.getGitHubRepository({
        providerId: deployTarget.project.source.provider_id
      });
      if (!remoteAuthedRepo) {
        console.log(deployTarget.project.source.provider_id, remoteAuthedRepo);
        throw new CliError(
          `Cannot access configured repository; check build settings on ${link(
            `${settingsUrl(deployTarget)}/settings`
          )}`
        );
      }

      // Configured repo is OK; proceed
      return;
    }

    if (!localRepo) {
      if (!this.effects.isTty)
        throw new CliError(
          "Cannot access repository for continuous deployment and cannot request access in non-interactive mode"
        );

      // Repo is not authorized; link to auth page and poll for auth
      const authUrl = new URL("/auth-github", OBSERVABLE_UI_ORIGIN);
      authUrl.searchParams.set("owner", ownerName);
      authUrl.searchParams.set("repo", repoName);
      this.effects.clack.log.info(`Authorize Observable to access the ${bold(repoName)} repository: ${link(authUrl)}`);

      const spinner = this.effects.clack.spinner();
      spinner.start("Waiting for repository to be authorized");
      const pollExpiration = Date.now() + DEPLOY_POLL_MAX_MS;
      while (!localRepo) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (Date.now() > pollExpiration) {
          spinner.stop("Waiting for repository to be authorized timed out.");
          throw new CliError("Repository authorization failed");
        }
        localRepo = await this.apiClient.getGitHubRepository({ownerName, repoName});
        if (localRepo) spinner.stop("Repository authorized.");
      }
    }

    const response = await this.apiClient.postProjectEnvironment(deployTarget.project.id, {
      source: {
        provider: localRepo.provider,
        provider_id: localRepo.provider_id,
        url: localRepo.url,
        branch
      }
    });

    if (!response) throw new CliError("Setting source repository for continuous deployment failed");

    // Configured repo is OK; proceed
    return;
  }

  private async startNewDeploy(): Promise<GetDeployResponse> {
    const {deployConfig, deployTarget} = await this.getDeployTarget(await this.getUpdatedDeployConfig());
    let deployId: string | null;
    if (deployConfig.continuousDeployment) {
      await this.validateGitHubLink(deployTarget);
      deployId = await this.cloudBuild(deployTarget);
    } else {
      const buildFilePaths = await this.getBuildFilePaths();
      deployId = await this.createNewDeploy(deployTarget);
      await this.uploadFiles(deployId, buildFilePaths);
      await this.markDeployUploaded(deployId);
    }
    return await this.pollForProcessingCompletion(deployId);
  }

  // Make sure deploy exists and has an expected status.
  private async checkDeployCreated(deployId: string) {
    try {
      const deployInfo = await this.apiClient.getDeploy(deployId);
      if (deployInfo.status !== "created") {
        throw new CliError(`Deploy ${deployId} has an unexpected status: ${deployInfo.status}`);
      }
      return deployInfo;
    } catch (error) {
      if (isHttpError(error)) {
        throw new CliError(`Deploy ${deployId} not found.`, {
          cause: error
        });
      }
      throw error;
    }
  }

  // Get the deploy config, updating if necessary.
  private async getUpdatedDeployConfig() {
    const deployConfig = await this.effects.getDeployConfig(
      this.deployOptions.config.root,
      this.deployOptions.deployConfigPath,
      this.effects
    );

    if (deployConfig.workspaceLogin && !deployConfig.workspaceLogin.match(/^@?[a-z0-9-]+$/)) {
      throw new CliError(
        `Found invalid workspace login in ${join(this.deployOptions.config.root, ".observablehq", "deploy.json")}: ${
          deployConfig.workspaceLogin
        }.`
      );
    }
    if (deployConfig.projectSlug && !deployConfig.projectSlug.match(/^[a-z0-9-]+$/)) {
      throw new CliError(
        `Found invalid \`projectSlug\` in ${join(this.deployOptions.config.root, ".observablehq", "deploy.json")}: ${
          deployConfig.projectSlug
        }.`
      );
    }

    if (deployConfig.projectId && (!deployConfig.projectSlug || !deployConfig.workspaceLogin)) {
      const spinner = this.effects.clack.spinner();
      this.effects.clack.log.warn("The `projectSlug` or `workspaceLogin` is missing from your deploy.json.");
      spinner.start(`Searching for app ${deployConfig.projectId}`);
      let found = false;
      for (const workspace of this.currentUser.workspaces) {
        const projects = await this.apiClient.getWorkspaceProjects(workspace.login);
        const project = projects.find((p) => p.id === deployConfig.projectId);
        if (project) {
          deployConfig.projectSlug = project.slug;
          deployConfig.workspaceLogin = workspace.login;
          await this.effects.setDeployConfig(
            this.deployOptions.config.root,
            this.deployOptions.deployConfigPath,
            deployConfig,
            this.effects
          );
          found = true;
          break;
        }
      }
      if (found) {
        spinner.stop(`App ${deployConfig.projectSlug} found in workspace @${deployConfig.workspaceLogin}.`);
      } else {
        spinner.stop(`App ${deployConfig.projectId} not found. Ignoring…`);
      }
    }

    return deployConfig;
  }

  // Get the deploy target, prompting the user as needed.
  private async getDeployTarget(
    deployConfig: DeployConfig
  ): Promise<{deployTarget: DeployTargetInfo; deployConfig: DeployConfig}> {
    let deployTarget: DeployTargetInfo;
    if (deployConfig.workspaceLogin && deployConfig.projectSlug) {
      try {
        const project = await this.apiClient.getProject({
          workspaceLogin: deployConfig.workspaceLogin,
          projectSlug: deployConfig.projectSlug
        });
        deployTarget = {create: false, workspace: project.owner, project};
      } catch (error) {
        if (!isHttpError(error) || error.statusCode !== 404) {
          throw error;
        }
      }
    }

    deployTarget ??= await promptDeployTarget(
      this.effects,
      this.deployOptions.config,
      this.apiClient,
      this.currentUser
    );

    if (!deployTarget.create) {
      // Check last deployed state. If it's not the same project, ask the user if
      // they want to continue anyways. In non-interactive mode just cancel.
      const targetDescription = `${deployTarget.project.title} (${deployTarget.project.slug}) in the @${deployTarget.workspace.login} workspace`;
      if (deployConfig.projectId && deployConfig.projectId !== deployTarget.project.id) {
        this.effects.clack.log.warn(
          wrapAnsi(
            `The \`projectId\` in your deploy.json does not match. Continuing will overwrite ${bold(
              targetDescription
            )}.`,
            this.effects.outputColumns
          )
        );
        if (this.effects.isTty) {
          const choice = await this.effects.clack.confirm({
            message: "Do you want to continue deploying?",
            active: "Yes, overwrite",
            inactive: "No, cancel"
          });
          if (!choice) {
            this.effects.clack.outro(yellow("Deploy canceled."));
          }
          if (this.effects.clack.isCancel(choice) || !choice) {
            throw new CliError("User canceled deploy", {print: false, exitCode: 0});
          }
        } else {
          throw new CliError("Cancelling deploy due to misconfiguration.");
        }
      } else if (deployConfig.projectId) {
        this.effects.clack.log.info(wrapAnsi(`Deploying to ${bold(targetDescription)}.`, this.effects.outputColumns));
      } else {
        this.effects.clack.log.warn(
          wrapAnsi(
            `The \`projectId\` in your deploy.json is missing. Continuing will overwrite ${bold(targetDescription)}.`,
            this.effects.outputColumns
          )
        );
        if (this.effects.isTty) {
          const choice = await this.effects.clack.confirm({
            message: "Do you want to continue deploying?",
            active: "Yes, overwrite",
            inactive: "No, cancel"
          });
          if (!choice) {
            this.effects.clack.outro(yellow("Deploy canceled."));
          }
          if (this.effects.clack.isCancel(choice) || !choice) {
            throw new CliError("User canceled deploy", {print: false, exitCode: 0});
          }
        } else {
          throw new CliError("Running non-interactively, cancelling due to conflict.");
        }
      }
    }

    if (deployTarget.create) {
      try {
        const project = await this.apiClient.postProject({
          slug: deployTarget.projectSlug,
          title: deployTarget.title,
          workspaceId: deployTarget.workspace.id,
          accessLevel: deployTarget.accessLevel
        });
        deployTarget = {create: false, workspace: deployTarget.workspace, project};
      } catch (error) {
        if (isApiError(error) && error.details.errors.some((e) => e.code === "TOO_MANY_PROJECTS")) {
          this.effects.clack.log.error(
            wrapAnsi(
              `The Starter tier can only deploy one app. Upgrade to unlimited apps at ${link(
                `https://observablehq.com/team/@${deployTarget.workspace.login}/settings`
              )}`,
              this.effects.outputColumns - 4
            )
          );
        } else {
          this.effects.clack.log.error(
            wrapAnsi(
              `Could not create app: ${error instanceof Error ? error.message : error}`,
              this.effects.outputColumns
            )
          );
        }
        this.effects.clack.outro(yellow("Deploy canceled"));
        throw new CliError("Error during deploy", {cause: error, print: false});
      }
    }

    let {continuousDeployment} = deployConfig;
    if (continuousDeployment === null) {
      const enable = await this.effects.clack.confirm({
        message: wrapAnsi(
          `Do you want to enable continuous deployment? ${faint(
            "Given a GitHub repository, this builds in the cloud and redeploys whenever you push to the current branch."
          )}`,
          this.effects.outputColumns
        ),
        active: "Yes, enable and build in cloud",
        inactive: "No, build locally"
      });
      if (this.effects.clack.isCancel(enable)) throw new CliError("User canceled deploy", {print: false, exitCode: 0});
      continuousDeployment = enable;
    }

    const newDeployConfig = {
      projectId: deployTarget.project.id,
      projectSlug: deployTarget.project.slug,
      workspaceLogin: deployTarget.workspace.login,
      continuousDeployment
    };

    await this.effects.setDeployConfig(
      this.deployOptions.config.root,
      this.deployOptions.deployConfigPath,
      newDeployConfig,
      this.effects
    );

    return {deployConfig: newDeployConfig, deployTarget};
  }

  // Create the new deploy on the server.
  private async createNewDeploy(deployTarget: DeployTargetInfo): Promise<string> {
    if (deployTarget.create) {
      throw Error("Incorrect deployTarget state");
    }

    let message = this.deployOptions.message;
    if (message === undefined) {
      if (this.effects.isTty) {
        const input = await this.effects.clack.text({
          message: "What changed in this deploy?",
          placeholder: "Enter a deploy message (optional)"
        });
        if (this.effects.clack.isCancel(input)) throw new CliError("User canceled deploy", {print: false, exitCode: 0});
        message = input;
      } else {
        message = "";
      }
    }

    let deployId;
    try {
      deployId = await this.apiClient.postDeploy({projectId: deployTarget.project.id, message});
    } catch (error) {
      if (isHttpError(error)) {
        if (error.statusCode === 404) {
          throw new CliError(
            `App ${deployTarget.project.slug} in workspace @${deployTarget.workspace.login} not found.`,
            {
              cause: error
            }
          );
        } else if (error.statusCode === 403) {
          throw new CliError(
            `You don't have permission to deploy to ${deployTarget.project.slug} in workspace @${deployTarget.workspace.login}.`,
            {cause: error}
          );
        }
      }
      throw error;
    }

    return deployId;
  }

  // Get the list of build files, doing a build if necessary.
  private async getBuildFilePaths(): Promise<string[]> {
    let doBuild = this.deployOptions.force === "build";
    let buildFilePaths: string[] | null = null;

    // Check if the build is missing. If it is present, then continue; otherwise
    // if --no-build was specified, then error; otherwise if in a tty, ask the
    // user if they want to build; otherwise build automatically.
    try {
      buildFilePaths = await this.findBuildFiles();
    } catch (error) {
      if (CliError.match(error, {message: /No build files found/})) {
        if (this.deployOptions.force === "deploy") {
          throw new CliError("No build files found.");
        } else if (!this.deployOptions.force) {
          if (this.effects.isTty) {
            const choice = await this.effects.clack.confirm({
              message: "No build files found. Do you want to build the app now?",
              active: "Yes, build and then deploy",
              inactive: "No, cancel deploy"
            });
            if (this.effects.clack.isCancel(choice) || !choice) {
              throw new CliError("User canceled deploy", {print: false, exitCode: 0});
            }
          }
          doBuild = true;
        }
      } else {
        throw error;
      }
    }

    // If we haven’t decided yet whether or not we’re building, check how old the
    // build is, and whether it is stale (i.e., whether the source files are newer
    // than the build). If in a tty, ask the user if they want to build; otherwise
    // deploy as is.
    if (!doBuild && !this.deployOptions.force && this.effects.isTty) {
      const leastRecentBuildMtimeMs = await this.findLeastRecentBuildMtimeMs();
      const mostRecentSourceMtimeMs = await this.findMostRecentSourceMtimeMs();
      const buildAge = Date.now() - leastRecentBuildMtimeMs;
      let initialValue = buildAge > BUILD_AGE_WARNING_MS;
      if (mostRecentSourceMtimeMs > leastRecentBuildMtimeMs) {
        this.effects.clack.log.warn(
          wrapAnsi(`Your source files have changed since you built ${formatAge(buildAge)}.`, this.effects.outputColumns)
        );
        initialValue = true;
      } else {
        this.effects.clack.log.info(wrapAnsi(`You built this app ${formatAge(buildAge)}.`, this.effects.outputColumns));
      }
      const choice = await this.effects.clack.confirm({
        message: "Would you like to build again before deploying?",
        initialValue,
        active: "Yes, build and then deploy",
        inactive: "No, deploy as is"
      });
      if (this.effects.clack.isCancel(choice)) throw new CliError("User canceled deploy", {print: false, exitCode: 0});
      doBuild = !!choice;
    }

    if (doBuild) {
      this.effects.clack.log.step("Building app");
      await this.effects.build(
        {config: this.deployOptions.config},
        new FileBuildEffects(
          this.deployOptions.config.output,
          join(this.deployOptions.config.root, ".observablehq", "cache"),
          {
            logger: this.effects.logger,
            output: this.effects.output
          }
        )
      );
      buildFilePaths = await this.findBuildFiles();
    }

    if (!buildFilePaths) throw new Error("No build files found.");
    return buildFilePaths;
  }

  private async findMostRecentSourceMtimeMs(): Promise<number> {
    let mostRecentMtimeMs = -Infinity;
    for await (const file of this.effects.visitFiles(this.deployOptions.config.root)) {
      const joinedPath = join(this.deployOptions.config.root, file);
      const stat = await this.effects.stat(joinedPath);
      if (stat.mtimeMs > mostRecentMtimeMs) {
        mostRecentMtimeMs = stat.mtimeMs;
      }
    }
    const cachePath = join(this.deployOptions.config.root, ".observablehq/cache");
    try {
      const cacheStat = await this.effects.stat(cachePath);
      if (cacheStat.mtimeMs > mostRecentMtimeMs) {
        mostRecentMtimeMs = cacheStat.mtimeMs;
      }
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
    }
    return mostRecentMtimeMs;
  }

  private async findLeastRecentBuildMtimeMs(): Promise<number> {
    let leastRecentMtimeMs = Infinity;
    for await (const file of this.effects.visitFiles(this.deployOptions.config.output)) {
      const joinedPath = join(this.deployOptions.config.output, file);
      const stat = await this.effects.stat(joinedPath);
      if (stat.mtimeMs < leastRecentMtimeMs) {
        leastRecentMtimeMs = stat.mtimeMs;
      }
    }
    return leastRecentMtimeMs;
  }

  private async findBuildFiles(): Promise<string[]> {
    const buildFilePaths: string[] = [];
    try {
      for await (const file of this.effects.visitFiles(this.deployOptions.config.output)) {
        buildFilePaths.push(file);
      }
    } catch (error) {
      if (isEnoent(error)) {
        throw new CliError(`No build files found at ${this.deployOptions.config.output}`, {cause: error});
      }
      throw error;
    }
    if (!buildFilePaths.length) {
      throw new CliError(`No build files found at ${this.deployOptions.config.output}`);
    }
    return buildFilePaths;
  }

  private async uploadFiles(deployId: string, buildFilePaths: string[]) {
    const progressSpinner = this.effects.clack.spinner();
    progressSpinner.start("");

    // upload a manifest before uploading the files
    progressSpinner.message("Hashing local files");
    const manifestFileInfo: DeployManifestFile[] = [];
    await runAllWithConcurrencyLimit(buildFilePaths, async (path) => {
      const fullPath = join(this.deployOptions.config.output, path);
      const statInfo = await stat(fullPath);
      const hash = createHash("sha512")
        .update(await readFile(fullPath))
        .digest("base64");
      manifestFileInfo.push({path, size: statInfo.size, hash});
    });
    progressSpinner.message("Sending file manifest to server");
    const instructions = await this.apiClient.postDeployManifest(deployId, manifestFileInfo);
    const fileErrors: {path: string; detail: string | null}[] = [];
    for (const fileInstruction of instructions.files) {
      if (fileInstruction.status === "error") {
        fileErrors.push({path: fileInstruction.path, detail: fileInstruction.detail});
      }
    }
    if (fileErrors.length) {
      this.effects.clack.log.error(
        "The server rejected some files from the upload:\n\n" +
          fileErrors.map(({path, detail}) => `  - ${path} - ${detail ? `(${detail})` : "no details"}`).join("\n")
      );
    }
    if (instructions.status === "error" || fileErrors.length) {
      throw new CliError(`Server rejected deploy manifest${instructions.detail ? `: ${instructions.detail}` : ""}`);
    }
    const filesToUpload: string[] = instructions.files
      .filter((instruction) => instruction.status === "upload")
      .map((instruction) => instruction.path);

    // Upload the files
    const rateLimiter = new RateLimiter(5);
    const waitForRateLimit = filesToUpload.length <= 300 ? async () => {} : () => rateLimiter.wait();

    await runAllWithConcurrencyLimit(
      filesToUpload,
      async (path, i) => {
        await waitForRateLimit();
        progressSpinner.message(
          `${i + 1} / ${filesToUpload.length} ${faint("uploading")} ${path.slice(0, this.effects.outputColumns - 17)}`
        );
        await this.apiClient.postDeployFile(deployId, join(this.deployOptions.config.output, path), path);
      },
      {maxConcurrency: this.deployOptions.maxConcurrency}
    );
    progressSpinner.stop(
      `${filesToUpload.length} uploaded, ${buildFilePaths.length - filesToUpload.length} unchanged, ${
        buildFilePaths.length
      } total.`
    );
  }

  private async markDeployUploaded(deployId: string) {
    // Mark the deploy as uploaded
    let buildManifest: null | BuildManifest = null;
    try {
      const source = await this.effects.readCacheFile(this.deployOptions.config.root, "_build.json");
      buildManifest = JSON.parse(source);
      Telemetry.record({event: "deploy", buildManifest: "found"});
    } catch (error) {
      if (isEnoent(error)) {
        Telemetry.record({event: "deploy", buildManifest: "missing"});
      } else {
        // The error message here might contain sensitive information, so
        // don't send it in telemetry.
        Telemetry.record({event: "deploy", buildManifest: "error"});
        this.effects.clack.log.warn(`Could not read build manifest: ${error}`);
      }
    }
    await this.apiClient.postDeployUploaded(deployId, buildManifest);
  }

  private async pollForProcessingCompletion(deployId: string): Promise<GetDeployResponse> {
    const {deployPollInterval: pollInterval = DEPLOY_POLL_INTERVAL_MS} = this.deployOptions;

    // Poll for processing completion
    const spinner = this.effects.clack.spinner();
    spinner.start("Server processing deploy");
    const pollExpiration = Date.now() + DEPLOY_POLL_MAX_MS;
    let deployInfo: null | GetDeployResponse = null;
    pollLoop: while (true) {
      if (Date.now() > pollExpiration) {
        spinner.stop("Deploy timed out");
        throw new CliError(`Deploy failed to process on server: status = ${deployInfo?.status}`);
      }
      deployInfo = await this.apiClient.getDeploy(deployId);
      switch (deployInfo.status) {
        case "created":
        case "pending":
          break;
        case "uploaded":
          spinner.stop("Deploy complete");
          break pollLoop;
        case "failed":
          spinner.stop("Deploy failed");
          throw new CliError("Deploy failed to process on server");
        case "canceled":
          spinner.stop("Deploy canceled");
          throw new CliError("Deploy canceled");
        default:
          spinner.stop("Unknown status");
          throw new CliError(`Unknown deploy status: ${deployInfo.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    if (!deployInfo) throw new CliError("Deploy failed to process on server");
    return deployInfo;
  }
}

// export for testing
export async function promptDeployTarget(
  effects: DeployEffects,
  config: Config,
  api: ObservableApiClient,
  currentUser: GetCurrentUserResponse
): Promise<DeployTargetInfo> {
  if (!effects.isTty) throw new CliError("Deploy not configured.");

  effects.clack.log.info("To configure deploy, we need to ask you a few questions.");

  if (currentUser.workspaces.length === 0) {
    effects.clack.log.error(
      `You don’t have any Observable workspaces. Go to ${underline("https://observablehq.com/team/new")} to create one.`
    );
    throw new CliError("No Observable workspace found.", {print: false, exitCode: 1});
  }
  let workspace: WorkspaceResponse;
  if (currentUser.workspaces.length === 1) {
    workspace = currentUser.workspaces[0];
    effects.clack.log.step(`Deploying to the ${bold(formatUser(workspace))} workspace.`);
  } else {
    const chosenWorkspace = await effects.clack.select<{value: WorkspaceResponse; label: string}[], WorkspaceResponse>({
      message: "Which Observable workspace do you want to use?",
      maxItems: Math.max(process.stdout.rows - 4, 0),
      options: currentUser.workspaces
        .map((w) => ({value: w, label: formatUser(w)}))
        .sort((a, b) => b.value.role.localeCompare(a.value.role) || a.label.localeCompare(b.label)),
      initialValue: currentUser.workspaces[0] // the oldest workspace, maybe?
    });
    if (effects.clack.isCancel(chosenWorkspace)) {
      throw new CliError("User canceled deploy.", {print: false, exitCode: 0});
    }
    workspace = chosenWorkspace;
  }

  let projectSlug: string | null = null;
  let existingProjects: GetProjectResponse[] = [];
  try {
    existingProjects = await api.getWorkspaceProjects(workspace.login);
  } catch (error) {
    if (isHttpError(error) && error.statusCode === 404) {
      throw new CliError(`Workspace ${workspace.login} not found.`, {cause: error});
    }
    throw error;
  }

  if (existingProjects.length > 0) {
    const chosenProject = await effects.clack.select<{value: string | null; label: string}[], string | null>({
      message: "Which app do you want to use?",
      maxItems: Math.max(process.stdout.rows - 4, 0),
      options: [
        {value: null, label: "Create a new app"},
        ...existingProjects
          .map((p) => ({
            value: p.slug,
            label: `${p.title} (${p.slug})`
          }))
          .sort((a, b) => a.label.localeCompare(b.label))
      ]
    });
    if (effects.clack.isCancel(chosenProject)) {
      throw new CliError("User canceled deploy.", {print: false, exitCode: 0});
    } else if (chosenProject !== null) {
      return {create: false, workspace, project: existingProjects.find((p) => p.slug === chosenProject)!};
    }
  } else {
    const confirmChoice = await effects.clack.confirm({
      message: "No apps found. Do you want to create a new app?",
      active: "Yes, continue",
      inactive: "No, cancel"
    });
    if (!confirmChoice) {
      effects.clack.outro(yellow("Deploy canceled."));
    }
    if (effects.clack.isCancel(confirmChoice) || !confirmChoice) {
      throw new CliError("User canceled deploy.", {print: false, exitCode: 0});
    }
  }

  let title = config.title;
  if (title === undefined) {
    effects.clack.log.warn("You haven’t configured a title for your app.");
    const titleChoice = await effects.clack.text({
      message: "What title do you want to use?",
      placeholder: "Enter an app title",
      validate: (title) => (title ? undefined : "A title is required.")
    });
    if (effects.clack.isCancel(titleChoice)) {
      throw new CliError("User canceled deploy.", {print: false, exitCode: 0});
    }
    title = titleChoice;
    effects.clack.log.info("You should add this title to your observablehq.config.js file.");
  }

  // TODO This should refer to the URL of the project, not the slug.
  const defaultProjectSlug = config.title ? slugify(config.title) : "";
  const projectSlugChoice = await effects.clack.text({
    message: "What slug do you want to use?",
    placeholder: defaultProjectSlug,
    defaultValue: defaultProjectSlug,
    validate: (slug) =>
      !slug || slug.match(/^[a-z0-9-]+$/)
        ? undefined
        : "Slugs must be lowercase and contain only letters, numbers, and hyphens."
  });
  if (effects.clack.isCancel(projectSlugChoice)) {
    throw new CliError("User canceled deploy.", {print: false, exitCode: 0});
  }
  projectSlug = projectSlugChoice;

  const accessLevel: string | symbol = await effects.clack.select({
    message: "Who is allowed to access your app?",
    options: [
      {value: "private", label: "Private", hint: "only allow workspace members"},
      {value: "public", label: "Public", hint: "allow anyone"}
    ]
  });
  if (effects.clack.isCancel(accessLevel)) {
    throw new CliError("User canceled deploy.", {print: false, exitCode: 0});
  }

  return {create: true, workspace, projectSlug, title, accessLevel};
}

function formatAge(age: number): string {
  if (age < 1000 * 60) {
    const seconds = Math.round(age / 1000);
    return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
  }
  if (age < 1000 * 60 * 60) {
    const minutes = Math.round(age / 1000 / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (age < 1000 * 60 * 60 * 12) {
    const hours = Math.round(age / 1000 / 60 / 60);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  return `at ${new Date(Date.now() - age).toLocaleString("sv")}`;
}

async function readCacheFile(sourceRoot: string, path: string): Promise<string> {
  const fullPath = join(sourceRoot, ".observablehq", "cache", path);
  return await readFile(fullPath, "utf8");
}
