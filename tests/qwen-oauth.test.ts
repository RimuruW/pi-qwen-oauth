import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import registerQwenOAuthProvider, {
  refreshQwenToken,
  loginQwen,
} from "../index.ts";

type ProviderRegistration = {
  name: string;
  config: {
    baseUrl: string;
    models: Array<{ id: string; compat?: { thinkingFormat?: string } }>;
    headers?: Record<string, string>;
    streamSimple?: unknown;
    oauth?: {
      name?: string;
      modifyModels?: (
        models: Array<{ provider: string; baseUrl?: string }>,
        credentials: { enterpriseUrl?: string },
      ) => Array<{ provider: string; baseUrl?: string }>;
    };
  };
};

type BeforeProviderRequestHandler = (event: { payload: unknown }) => unknown;

type CommandRegistration = {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
  getArgumentCompletions?: (
    prefix: string,
  ) => Array<{ value: string; label: string }> | null;
};

function registerExtension(): {
  providers: Map<string, ProviderRegistration>;
  commands: Map<string, CommandRegistration>;
  unregisteredProviders: string[];
  beforeProviderRequest?: BeforeProviderRequestHandler;
} {
  const providers = new Map<string, ProviderRegistration>();
  const commands = new Map<string, CommandRegistration>();
  const unregisteredProviders: string[] = [];
  let beforeProviderRequest: BeforeProviderRequestHandler | undefined;

  registerQwenOAuthProvider({
    registerProvider(name: string, config: ProviderRegistration["config"]) {
      providers.set(name, { name, config });
    },
    unregisterProvider(name: string) {
      unregisteredProviders.push(name);
      providers.delete(name);
    },
    registerCommand(name: string, config: CommandRegistration) {
      commands.set(name, config);
    },
    on(event: string, handler: BeforeProviderRequestHandler) {
      if (event === "before_provider_request") {
        beforeProviderRequest = handler;
      }
    },
  } as never);

  if (!providers.has("qwen-oauth")) {
    throw new Error("Provider registration was not captured");
  }

  return { providers, commands, unregisteredProviders, beforeProviderRequest };
}

async function withEnv<T>(
  env: Record<string, string | undefined>,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withTempHome<T>(
  run: (homeDir: string) => Promise<T> | T,
): Promise<T> {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "pi-qwen-oauth-test-"));
  return withEnv(
    {
      HOME: homeDir,
      USERPROFILE: homeDir,
    },
    async () => {
      try {
        return await run(homeDir);
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    },
  );
}

function agentFile(homeDir: string, fileName: string): string {
  return path.join(homeDir, ".pi", "agent", fileName);
}

function writeJson(homeDir: string, fileName: string, value: unknown): void {
  const filePath = agentFile(homeDir, fileName);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function readJson(homeDir: string, fileName: string): unknown {
  return JSON.parse(readFileSync(agentFile(homeDir, fileName), "utf-8"));
}

function createCommandContext(options?: {
  hasUI?: boolean;
  inputResponses?: string[];
  confirmResponses?: boolean[];
  selectResponses?: string[];
}) {
  const notifications: Array<{ message: string; level: string }> = [];
  const inputResponses = [...(options?.inputResponses || [])];
  const confirmResponses = [...(options?.confirmResponses || [])];
  const selectResponses = [...(options?.selectResponses || [])];
  let refreshCount = 0;

  const ctx = {
    hasUI: options?.hasUI ?? true,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      async input() {
        return inputResponses.shift() || "";
      },
      async confirm() {
        return confirmResponses.shift() || false;
      },
      async select() {
        return selectResponses.shift();
      },
    },
    modelRegistry: {
      refresh() {
        refreshCount++;
      },
    },
  };

  return {
    ctx,
    notifications,
    get refreshCount() {
      return refreshCount;
    },
  };
}

test("registers Qwen OAuth against the Qwen portal endpoint by default", () => {
  const { providers } = registerExtension();
  const registration = providers.get("qwen-oauth");
  if (!registration) throw new Error("Expected qwen-oauth provider");

  assert.equal(registration.name, "qwen-oauth");
  assert.equal(registration.config.baseUrl, "https://portal.qwen.ai/v1");
});

test("registers only the coder-model", () => {
  const { providers } = registerExtension();
  const registration = providers.get("qwen-oauth");
  if (!registration) throw new Error("Expected qwen-oauth provider");

  assert.deepEqual(
    registration.config.models.map((model) => model.id),
    ["coder-model"],
  );
});

test("maps OAuth resource_url from portal hosts to /v1 instead of /compatible-mode/v1", () => {
  const { providers } = registerExtension();
  const registration = providers.get("qwen-oauth");
  if (!registration) throw new Error("Expected qwen-oauth provider");
  const modifyModels = registration.config.oauth?.modifyModels;

  if (!modifyModels) {
    throw new Error("Expected oauth.modifyModels to be registered");
  }

  const [model] = modifyModels(
    [{ provider: "qwen-oauth", baseUrl: "https://placeholder.invalid" }],
    { enterpriseUrl: "portal.qwen.ai" },
  );

  assert.equal(model?.baseUrl, "https://portal.qwen.ai/v1");
});

test("keeps DashScope hosts on the OpenAI-compatible /compatible-mode/v1 path", () => {
  const { providers } = registerExtension();
  const registration = providers.get("qwen-oauth");
  if (!registration) throw new Error("Expected qwen-oauth provider");
  const modifyModels = registration.config.oauth?.modifyModels;

  if (!modifyModels) {
    throw new Error("Expected oauth.modifyModels to be registered");
  }

  const [model] = modifyModels(
    [{ provider: "qwen-oauth", baseUrl: "https://placeholder.invalid" }],
    { enterpriseUrl: "dashscope.aliyuncs.com" },
  );

  assert.equal(
    model?.baseUrl,
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
});

test("adds the Qwen Portal headers required for OAuth chat completions", () => {
  const { providers } = registerExtension();
  const registration = providers.get("qwen-oauth");
  if (!registration) throw new Error("Expected qwen-oauth provider");

  assert.deepEqual(registration.config.headers, {
    "X-DashScope-AuthType": "qwen-oauth",
    "X-DashScope-UserAgent": "QwenCode/0.14.3 (darwin; arm64)",
    "User-Agent": "QwenCode/0.14.3 (darwin; arm64)",
  });
});

test("uses the default openai-completions stream implementation", () => {
  const { providers } = registerExtension();
  const registration = providers.get("qwen-oauth");
  if (!registration) throw new Error("Expected qwen-oauth provider");

  assert.equal(registration.config.streamSimple, undefined);
});

test("normalizes coder-model payloads to include a system message with content parts", () => {
  const { beforeProviderRequest } = registerExtension();
  if (!beforeProviderRequest) {
    throw new Error(
      "Expected before_provider_request handler to be registered",
    );
  }

  const normalized = beforeProviderRequest({
    payload: {
      model: "coder-model",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    },
  }) as { messages: Array<{ role: string; content: unknown }> };

  assert.deepEqual(normalized.messages, [
    { role: "system", content: [{ type: "text", text: "" }] },
    { role: "user", content: "hi" },
  ]);
});

test("converts existing system string content into Qwen Portal content parts", () => {
  const { beforeProviderRequest } = registerExtension();
  if (!beforeProviderRequest) {
    throw new Error(
      "Expected before_provider_request handler to be registered",
    );
  }

  const normalized = beforeProviderRequest({
    payload: {
      model: "coder-model",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "describe the image" },
      ],
    },
  }) as { messages: Array<{ role: string; content: unknown }> };

  assert.deepEqual(normalized.messages, [
    { role: "system", content: [{ type: "text", text: "You are helpful." }] },
    { role: "user", content: "describe the image" },
  ]);
});

test("leaves non-Qwen payloads untouched", () => {
  const { beforeProviderRequest } = registerExtension();
  if (!beforeProviderRequest) {
    throw new Error(
      "Expected before_provider_request handler to be registered",
    );
  }

  const payload = {
    model: "gpt-4.1",
    messages: [{ role: "user", content: "hi" }],
  };

  assert.deepEqual(beforeProviderRequest({ payload }), payload);
});

test("uses thinkingFormat qwen to map effort to enable_thinking boolean", () => {
  const { providers } = registerExtension();
  const registration = providers.get("qwen-oauth");
  if (!registration) throw new Error("Expected qwen-oauth provider");

  for (const model of registration.config.models) {
    assert.equal(
      model.compat?.thinkingFormat,
      "qwen",
      `model ${model.id} should use thinkingFormat \"qwen\"`,
    );
  }
});

test("registers extra providers from the multi-account store in profiles mode", async () => {
  await withTempHome(async (homeDir) => {
    writeJson(homeDir, "qwen-oauth-profiles.json", {
      version: 2,
      accounts: [
        { provider: "qwen-oauth", label: "Default" },
        { provider: "qwen-oauth-2", label: "Work" },
      ],
    });

    const { providers, commands } = await withEnv(
      { PI_QWEN_OAUTH_PROFILES: "true" },
      () => registerExtension(),
    );

    assert.deepEqual([...providers.keys()].sort(), [
      "qwen-oauth",
      "qwen-oauth-2",
    ]);
    assert.equal(
      providers.get("qwen-oauth-2")?.config.oauth?.name,
      "Qwen OAuth — Work",
    );
    assert.ok(
      commands.has("qwen-profile"),
      "expected account management command to remain registered",
    );
  });
});

test("profiles mode does not auto-migrate legacy profile stores at startup", async () => {
  await withTempHome(async (homeDir) => {
    const legacyStore = {
      version: 1,
      activeProfile: "work",
      profiles: [
        { key: "default", label: "Default" },
        { key: "work", label: "Work" },
      ],
      credentials: {
        default: {
          access: "default-access",
          refresh: "default-refresh",
          expires: 111111,
          enterpriseUrl: "portal.qwen.ai",
        },
        work: {
          access: "work-access",
          refresh: "work-refresh",
          expires: 222222,
          enterpriseUrl: "dashscope.aliyuncs.com",
        },
      },
    };
    writeJson(homeDir, "qwen-oauth-profiles.json", legacyStore);
    writeJson(homeDir, "auth.json", {});

    const { providers, commands } = await withEnv(
      { PI_QWEN_OAUTH_PROFILES: "true" },
      () => registerExtension(),
    );

    assert.deepEqual([...providers.keys()], ["qwen-oauth"]);
    assert.ok(
      commands.has("qwen-profile"),
      "expected account management command to remain registered",
    );
    assert.deepEqual(
      readJson(homeDir, "qwen-oauth-profiles.json"),
      legacyStore,
    );
    assert.deepEqual(readJson(homeDir, "auth.json"), {});
  });
});

test("normal mode does not import active legacy profile credentials", async () => {
  await withTempHome(async (homeDir) => {
    writeJson(homeDir, "qwen-oauth-profiles.json", {
      version: 1,
      activeProfile: "work",
      profiles: [
        { key: "default", label: "Default" },
        { key: "work", label: "Work" },
      ],
      credentials: {
        work: {
          access: "legacy-access",
          refresh: "legacy-refresh",
          expires: 222222,
          enterpriseUrl: "dashscope.aliyuncs.com",
        },
      },
    });
    writeJson(homeDir, "auth.json", {});

    registerExtension();

    assert.deepEqual(readJson(homeDir, "auth.json"), {});
  });
});

test("qwen-profile list shows logged-in, refresh-pending, and logged-out account states", async () => {
  await withTempHome(async (homeDir) => {
    writeJson(homeDir, "qwen-oauth-profiles.json", {
      version: 2,
      accounts: [
        { provider: "qwen-oauth", label: "Default" },
        { provider: "qwen-oauth-2", label: "Work" },
        { provider: "qwen-oauth-3", label: "Personal" },
      ],
    });
    writeJson(homeDir, "auth.json", {
      "qwen-oauth": {
        type: "oauth",
        access: "live-access",
        refresh: "live-refresh",
        expires: Date.now() + 60_000,
      },
      "qwen-oauth-2": {
        type: "oauth",
        access: "stale-access",
        refresh: "stale-refresh",
        expires: Date.now() - 60_000,
      },
    });

    const { commands } = await withEnv({ PI_QWEN_OAUTH_PROFILES: "true" }, () =>
      registerExtension(),
    );
    const command = commands.get("qwen-profile");
    if (!command) throw new Error("Expected qwen-profile command");
    const { ctx, notifications } = createCommandContext({ hasUI: false });

    await command.handler("list", ctx);

    assert.deepEqual(notifications, [
      {
        message: [
          "Default (qwen-oauth) - logged in",
          "Work (qwen-oauth-2) - token expired — will refresh on next request",
          "Personal (qwen-oauth-3) - not logged in",
        ].join("\n"),
        level: "info",
      },
    ]);
  });
});

test("qwen-profile add persists a new account, registers its provider, and prompts login", async () => {
  await withTempHome(async (homeDir) => {
    writeJson(homeDir, "qwen-oauth-profiles.json", {
      version: 2,
      accounts: [{ provider: "qwen-oauth", label: "Default" }],
    });

    const { commands, providers } = await withEnv(
      { PI_QWEN_OAUTH_PROFILES: "true" },
      () => registerExtension(),
    );
    const command = commands.get("qwen-profile");
    if (!command) throw new Error("Expected qwen-profile command");
    const commandCtx = createCommandContext();

    await command.handler("add Work", commandCtx.ctx);

    assert.deepEqual(readJson(homeDir, "qwen-oauth-profiles.json"), {
      version: 2,
      accounts: [
        { provider: "qwen-oauth", label: "Default" },
        { provider: "qwen-oauth-2", label: "Work" },
      ],
    });
    assert.equal(
      providers.get("qwen-oauth-2")?.config.oauth?.name,
      "Qwen OAuth — Work",
    );
    assert.equal(commandCtx.refreshCount, 1);
    assert.deepEqual(commandCtx.notifications, [
      { message: "Added account: Work (qwen-oauth-2)", level: "info" },
      {
        message:
          'Use /login and select "Qwen OAuth — Work" to authenticate Work.',
        level: "info",
      },
    ]);
  });
});

test("qwen-profile rename updates metadata and provider display name", async () => {
  await withTempHome(async (homeDir) => {
    writeJson(homeDir, "qwen-oauth-profiles.json", {
      version: 2,
      accounts: [
        { provider: "qwen-oauth", label: "Default" },
        { provider: "qwen-oauth-2", label: "Work" },
      ],
    });

    const { commands, providers } = await withEnv(
      { PI_QWEN_OAUTH_PROFILES: "true" },
      () => registerExtension(),
    );
    const command = commands.get("qwen-profile");
    if (!command) throw new Error("Expected qwen-profile command");
    const commandCtx = createCommandContext();

    await command.handler("rename qwen-oauth-2 Team", commandCtx.ctx);

    assert.deepEqual(readJson(homeDir, "qwen-oauth-profiles.json"), {
      version: 2,
      accounts: [
        { provider: "qwen-oauth", label: "Default" },
        { provider: "qwen-oauth-2", label: "Team" },
      ],
    });
    assert.equal(
      providers.get("qwen-oauth-2")?.config.oauth?.name,
      "Qwen OAuth — Team",
    );
    assert.equal(commandCtx.refreshCount, 1);
    assert.deepEqual(commandCtx.notifications, [
      { message: "Renamed qwen-oauth-2 to: Team", level: "info" },
    ]);
  });
});

test("qwen-profile remove deletes the auth entry and unregisters the provider", async () => {
  await withTempHome(async (homeDir) => {
    writeJson(homeDir, "qwen-oauth-profiles.json", {
      version: 2,
      accounts: [
        { provider: "qwen-oauth", label: "Default" },
        { provider: "qwen-oauth-2", label: "Work" },
      ],
    });
    writeJson(homeDir, "auth.json", {
      "qwen-oauth": {
        type: "oauth",
        access: "default-access",
        refresh: "default-refresh",
        expires: Date.now() + 60_000,
      },
      "qwen-oauth-2": {
        type: "oauth",
        access: "work-access",
        refresh: "work-refresh",
        expires: Date.now() + 60_000,
      },
    });

    const { commands, providers, unregisteredProviders } = await withEnv(
      { PI_QWEN_OAUTH_PROFILES: "true" },
      () => registerExtension(),
    );
    const command = commands.get("qwen-profile");
    if (!command) throw new Error("Expected qwen-profile command");
    const commandCtx = createCommandContext();

    await command.handler("remove qwen-oauth-2", commandCtx.ctx);

    assert.deepEqual(readJson(homeDir, "qwen-oauth-profiles.json"), {
      version: 2,
      accounts: [{ provider: "qwen-oauth", label: "Default" }],
    });
    const auth = readJson(homeDir, "auth.json") as Record<string, unknown>;
    assert.ok(!("qwen-oauth-2" in auth));
    const defaultEntry = auth["qwen-oauth"] as Record<string, unknown>;
    assert.equal(defaultEntry.type, "oauth");
    assert.equal(defaultEntry.access, "default-access");
    assert.equal(defaultEntry.refresh, "default-refresh");
    assert.equal(typeof defaultEntry.expires, "number");
    assert.ok(!providers.has("qwen-oauth-2"));
    assert.deepEqual(unregisteredProviders, ["qwen-oauth-2"]);
    assert.equal(commandCtx.refreshCount, 1);
    assert.deepEqual(commandCtx.notifications, [
      { message: "Removed account: qwen-oauth-2", level: "info" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Token refresh tests
// ---------------------------------------------------------------------------

const QWEN_TOKEN_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/token";

const mockFetch = (response: {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
}) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(url.toString(), QWEN_TOKEN_ENDPOINT);
    assert.equal((init as RequestInit).method, "POST");

    const body = (init as RequestInit).body as string;
    const params = new URLSearchParams(body);
    assert.equal(params.get("grant_type"), "refresh_token");
    assert.equal(params.get("client_id"), "f0304373b74a44d2b584a3fb70ca9e56");

    return {
      ok: response.ok,
      status: response.status ?? 200,
      json: response.json,
      text: response.text ?? (async () => ""),
    } as Response;
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
};

test("refreshQwenToken returns new access_token and new refresh_token", async () => {
  const restore = mockFetch({
    ok: true,
    json: async () => ({
      access_token: "new-access",
      refresh_token: "new-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    }),
  });

  const result = await refreshQwenToken({
    access: "old-access",
    refresh: "old-refresh",
    expires: Date.now() - 1000,
  });

  restore();

  assert.equal(result.access, "new-access");
  assert.equal(result.refresh, "new-refresh");
  const delta = result.expires - Date.now();
  assert.ok(
    delta > 3290 * 1000 && delta < 3301 * 1000,
    `expiry delta ${delta}ms should be ~3300000ms`,
  );
});

test("refreshQwenToken preserves old refresh_token when response has none", async () => {
  const restore = mockFetch({
    ok: true,
    json: async () => ({
      access_token: "new-access",
      token_type: "Bearer",
      expires_in: 3600,
    }),
  });

  const result = await refreshQwenToken({
    access: "old-access",
    refresh: "keep-me",
    expires: Date.now() - 1000,
  });

  restore();

  assert.equal(result.access, "new-access");
  assert.equal(result.refresh, "keep-me");
});

test("refreshQwenToken throws when refresh token is missing", async () => {
  await assert.rejects(
    refreshQwenToken({
      access: "some-access",
      refresh: "",
      expires: Date.now() - 1000,
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok((err as Error).message.includes("refresh token is missing"));
      return true;
    },
  );
});

test("refreshQwenToken throws on HTTP error response", async () => {
  const restore = mockFetch({
    ok: false,
    status: 401,
    json: async () => ({ error: "invalid_grant" }),
    text: async () => '{"error":"invalid_grant"}',
  });

  await assert.rejects(
    refreshQwenToken({
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 1000,
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok((err as Error).message.includes("401"));
      assert.ok((err as Error).message.includes("token refresh failed"));
      return true;
    },
  );

  restore();
});

test("refreshQwenToken throws when access_token is missing from response", async () => {
  const restore = mockFetch({
    ok: true,
    json: async () => ({
      refresh_token: "some-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    }),
  });

  await assert.rejects(
    refreshQwenToken({
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 1000,
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        (err as Error).message.includes("did not include an access token"),
      );
      return true;
    },
  );

  restore();
});

// ---------------------------------------------------------------------------
// Login flow tests
// ---------------------------------------------------------------------------

const QWEN_DEVICE_CODE_ENDPOINT =
  "https://chat.qwen.ai/api/v1/oauth2/device/code";

const mockDeviceFlowFetch = (
  deviceCodeResponse: () => Promise<unknown>,
  tokenResponses: Array<{ ok: boolean; json: () => Promise<unknown> }>,
) => {
  const originalFetch = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlString = url.toString();
    if (urlString === QWEN_DEVICE_CODE_ENDPOINT) {
      return {
        ok: true,
        status: 200,
        json: deviceCodeResponse,
        signal: (init as RequestInit)?.signal,
      } as unknown as Response;
    }
    if (urlString === QWEN_TOKEN_ENDPOINT) {
      const response =
        tokenResponses[callIndex++] ||
        tokenResponses[tokenResponses.length - 1];
      return {
        ok: response.ok,
        status: 200,
        json: response.json,
      } as Response;
    }
    throw new Error(`Unexpected fetch URL: ${urlString}`);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
};

test("loginQwen throws immediately when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    loginQwen({
      onAuth: () => {},
      onPrompt: async () => "",
      signal: controller.signal,
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok((err as Error).message.includes("login cancelled"));
      return true;
    },
  );
});

test("loginQwen passes signal to device code fetch", async () => {
  const controller = new AbortController();
  let capturedSignal: AbortSignal | undefined;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    if (url.toString() === QWEN_DEVICE_CODE_ENDPOINT) {
      capturedSignal = (init as RequestInit)?.signal as AbortSignal | undefined;
    }
    throw new Error("abort early");
  };

  await assert.rejects(
    loginQwen({
      onAuth: () => {},
      onPrompt: async () => "",
      signal: controller.signal,
    }),
  );

  globalThis.fetch = originalFetch;

  assert.ok(
    capturedSignal === controller.signal,
    "signal should be passed to device code fetch",
  );
});

test("loginQwen calls onProgress during long poll", async () => {
  const progressMessages: string[] = [];

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((cb: (...args: unknown[]) => void) => {
    queueMicrotask(() => cb());
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  const restore = mockDeviceFlowFetch(
    async () => ({
      device_code: "dev-123",
      user_code: "ABCD",
      verification_uri: "https://example.com/auth",
      expires_in: 60,
      interval: 0,
    }),
    [
      ...Array(9).fill({
        ok: false,
        json: async () => ({ error: "authorization_pending" }),
      }),
      {
        ok: false,
        json: async () => ({ error: "authorization_pending" }),
      },
      {
        ok: true,
        json: async () => ({
          access_token: "tok",
          refresh_token: "ref",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      },
    ],
  );

  try {
    const result = await loginQwen({
      onAuth: () => {},
      onPrompt: async () => "",
      onProgress: (msg) => progressMessages.push(msg),
    });

    assert.deepEqual(progressMessages, ["Waiting for browser authorization…"]);
    assert.equal(result.access, "tok");
    assert.equal(result.refresh, "ref");
  } finally {
    restore();
    globalThis.setTimeout = originalSetTimeout;
  }
});
