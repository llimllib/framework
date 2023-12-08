import type {MockAgent} from "undici";
import {type Interceptable} from "undici";
import {getObservableApiHost} from "../../src/observableApiClient.js";
import type {BaseFixtures, TestFixture} from "./composeTest.js";

export function withObservableApiMock<FIn extends BaseFixtures & {undiciAgent?: MockAgent}>(): TestFixture<
  FIn,
  FIn & {observableApiMock: ObservableApiMock}
> {
  return (testFunction) => {
    return async (args) => {
      if (!args.undiciAgent) throw new Error("withObservableApiMock requires withUndiciAgent");
      const observableApiMock = new ObservableApiMock(args.undiciAgent);
      await testFunction({...args, observableApiMock});
      observableApiMock.assertNoPendingIntercepts();
    };
  };
}

export const validApiKey = "MOCK-VALID-KEY";
export const invalidApiKey = "MOCK-INVALID-KEY";

const emptyErrorBody = JSON.stringify({errors: []});

export class ObservableApiMock {
  private _handlers: ((pool: Interceptable) => void)[] = [];
  private _origin = getObservableApiHost().toString().replace(/\/$/, "");

  constructor(private _agent: MockAgent) {}

  public done() {
    const mockPool = this._agent.get(this._origin);
    for (const handler of this._handlers) handler(mockPool);
  }

  public assertNoPendingIntercepts() {
    for (const intercept of this._agent.pendingInterceptors()) {
      if (intercept.origin === this._origin) {
        console.log(`Expected all intercepts for ${this._origin} to be handled`);
        this._agent.assertNoPendingInterceptors();
      }
    }
  }

  handleGetUser({user = userWithOneWorkspace, status = 200}: {user?: any; status?: number} = {}): ObservableApiMock {
    const response = status == 200 ? JSON.stringify(user) : emptyErrorBody;
    const headers = authorizationHeader(status != 401);
    this._handlers.push((pool) =>
      pool.intercept({path: "/cli/user", headers: headersMatcher(headers)}).reply(status, response)
    );
    return this;
  }

  handlePostProject({projectId, status = 200}: {projectId?: string; status?: number} = {}): ObservableApiMock {
    const response = status == 200 ? JSON.stringify({id: projectId}) : emptyErrorBody;
    const headers = authorizationHeader(status != 401);
    this._handlers.push((pool) =>
      pool.intercept({path: "/cli/project", method: "POST", headers: headersMatcher(headers)}).reply(status, response)
    );
    return this;
  }

  handlePostDeploy({
    projectId,
    deployId,
    status = 200
  }: {projectId?: string; deployId?: string; status?: number} = {}): ObservableApiMock {
    const response = status == 200 ? JSON.stringify({id: deployId}) : emptyErrorBody;
    const headers = authorizationHeader(status != 401);
    this._handlers.push((pool) =>
      pool
        .intercept({path: `/cli/project/${projectId}/deploy`, method: "POST", headers: headersMatcher(headers)})
        .reply(status, response)
    );
    return this;
  }

  handlePostDeployFile({
    deployId,
    status = 204,
    repeat = 1
  }: {deployId?: string; status?: number; repeat?: number} = {}): ObservableApiMock {
    const response = status == 204 ? "" : emptyErrorBody;
    const headers = authorizationHeader(status != 401);
    this._handlers.push((pool) => {
      pool
        .intercept({path: `/cli/deploy/${deployId}/file`, method: "POST", headers: headersMatcher(headers)})
        .reply(status, response)
        .times(repeat);
    });
    return this;
  }

  handlePostDeployUploaded({deployId, status = 204}: {deployId?: string; status?: number} = {}): ObservableApiMock {
    const response = status == 204 ? JSON.stringify({id: deployId, status: "uploaded"}) : emptyErrorBody;
    const headers = authorizationHeader(status != 401);
    this._handlers.push((pool) =>
      pool
        .intercept({path: `/cli/deploy/${deployId}/uploaded`, method: "POST", headers: headersMatcher(headers)})
        .reply(status, response)
    );
    return this;
  }
}

function authorizationHeader(valid: boolean) {
  return {authorization: valid ? `apikey ${validApiKey}` : `apikey ${invalidApiKey}`};
}

/** All headers in `expected` must be present and have the expected value.
 *
 * If `expected` contains an "undefined" value, then it asserts that the header
 * is not present in the actual headers. */
function headersMatcher(expected: Record<string, string>): (headers: Record<string, string>) => boolean {
  const lowercaseExpected = Object.fromEntries(Object.entries(expected).map(([key, val]) => [key.toLowerCase(), val]));
  return (actual) => {
    const lowercaseActual = Object.fromEntries(Object.entries(actual).map(([key, val]) => [key.toLowerCase(), val]));
    for (const [key, expected] of Object.entries(lowercaseExpected)) {
      if (lowercaseActual[key] !== expected) return false;
    }
    return true;
  };
}

const userBase = {
  id: "0000000000000000",
  login: "mock-user",
  name: "Mock User",
  tier: "public",
  has_workspace: false
};

const workspace1 = {
  id: "0000000000000001",
  login: "mock-user-ws",
  name: "Mock User's Workspace",
  tier: "pro",
  type: "team",
  role: "owner"
};

const workspace2 = {
  id: "0000000000000002",
  login: "mock-user-ws-2",
  name: "Mock User's Second Workspace",
  tier: "pro",
  type: "team",
  role: "owner"
};

export const userWithZeroWorkspaces = {
  ...userBase,
  workspaces: []
};

export const userWithOneWorkspace = {
  ...userBase,
  workspaces: [workspace1]
};

export const userWithTwoWorkspaces = {
  ...userBase,
  workspaces: [workspace1, workspace2]
};
