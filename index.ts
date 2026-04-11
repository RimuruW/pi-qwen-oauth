/**
 * Qwen OAuth provider for pi.
 *
 * Registers Qwen OAuth device login and the current Qwen OAuth model aliases
 * exposed through the Qwen Portal OpenAI-compatible chat completions API.
 *
 * The Qwen Portal API only supports `enable_thinking: true/false` (boolean).
 * It does NOT support `thinking_budget` — effort granularity is not available.
 * pi-ai's `thinkingFormat: "qwen"` maps the TUI effort selector to this boolean
 * (off → false, any effort level → true), so thinking can be toggled on/off.
 *
 * Multi-account mode (PI_QWEN_OAUTH_PROFILES=true):
 * Registers one provider per Qwen OAuth account (`qwen-oauth`,
 * `qwen-oauth-2`, ...) so pi sessions do not share a global active profile.
 * Use /qwen-profile to add, rename, remove, and list accounts.
 */

import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QWEN_DEVICE_CODE_ENDPOINT =
  "https://chat.qwen.ai/api/v1/oauth2/device/code";
const QWEN_TOKEN_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/token";
const QWEN_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
const QWEN_SCOPE = "openid profile email model.completion";
const QWEN_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const QWEN_DEFAULT_BASE_URL = "https://portal.qwen.ai/v1";
const QWEN_DEFAULT_POLL_INTERVAL_MS = 2000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const QWEN_PORTAL_USER_AGENT = "QwenCode/0.14.3 (darwin; arm64)";

function profilesEnabled(): boolean {
  return process.env.PI_QWEN_OAUTH_PROFILES === "true";
}

// ---------------------------------------------------------------------------
// Device / Token interfaces
// ---------------------------------------------------------------------------

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  resource_url?: string;
  error?: string;
  error_description?: string;
}

// ---------------------------------------------------------------------------
// Model config
// ---------------------------------------------------------------------------

interface QwenModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const MODELS: QwenModelConfig[] = [
  {
    id: "coder-model",
    name: "Qwen Coder",
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 65536,
  },
];

// ---------------------------------------------------------------------------
// Account store (multi-account mode)
// ---------------------------------------------------------------------------

interface ManagedAccount {
  provider: string;
  label: string;
}

interface AccountStoreData {
  version: 2;
  accounts: ManagedAccount[];
}

function getProfilesFilePath(): string {
  return path.join(os.homedir(), ".pi", "agent", "qwen-oauth-profiles.json");
}

function getDefaultAccountStoreData(): AccountStoreData {
  return {
    version: 2,
    accounts: [{ provider: "qwen-oauth", label: "Default" }],
  };
}

function readRawProfilesFile(): unknown {
  const filePath = getProfilesFilePath();
  try {
    if (!fs.existsSync(filePath)) return undefined;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

function isManagedAccount(value: unknown): value is ManagedAccount {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ManagedAccount).provider === "string" &&
    typeof (value as ManagedAccount).label === "string"
  );
}

function normalizeAccountStore(raw: unknown): AccountStoreData {
  if (
    !raw ||
    typeof raw !== "object" ||
    (raw as { version?: number }).version !== 2 ||
    !Array.isArray((raw as { accounts?: unknown[] }).accounts)
  ) {
    return getDefaultAccountStoreData();
  }

  const accounts = (raw as { accounts: unknown[] }).accounts.filter(
    isManagedAccount,
  );
  return {
    version: 2,
    accounts:
      accounts.length > 0 ? accounts : getDefaultAccountStoreData().accounts,
  };
}

function loadAccountStore(): AccountStoreData {
  return normalizeAccountStore(readRawProfilesFile());
}

function saveAccountStore(data: AccountStoreData): void {
  const filePath = getProfilesFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function getAccount(
  store: AccountStoreData,
  provider: string,
): ManagedAccount | undefined {
  return store.accounts.find((account) => account.provider === provider);
}

function isDefaultProvider(provider: string): boolean {
  return provider === "qwen-oauth";
}

function getProviderOAuthName(account: ManagedAccount): string {
  if (isDefaultProvider(account.provider) && account.label === "Default") {
    return "Qwen OAuth";
  }
  return `Qwen OAuth — ${account.label}`;
}

function nextAccountProviderName(store: AccountStoreData): string {
  let index = 2;
  const used = new Set(store.accounts.map((account) => account.provider));
  while (used.has(`qwen-oauth-${index}`)) {
    index++;
  }
  return `qwen-oauth-${index}`;
}

function addAccount(store: AccountStoreData, label: string): ManagedAccount {
  const account: ManagedAccount = {
    provider: nextAccountProviderName(store),
    label,
  };
  store.accounts.push(account);
  saveAccountStore(store);
  return account;
}

function renameAccountLabel(
  store: AccountStoreData,
  provider: string,
  label: string,
): boolean {
  const account = getAccount(store, provider);
  if (!account) return false;
  account.label = label;
  saveAccountStore(store);
  return true;
}

function removeAccount(store: AccountStoreData, provider: string): boolean {
  if (isDefaultProvider(provider)) return false;
  const index = store.accounts.findIndex(
    (account) => account.provider === provider,
  );
  if (index < 0) return false;
  store.accounts.splice(index, 1);
  saveAccountStore(store);
  return true;
}

// ---------------------------------------------------------------------------
// auth.json helpers
// ---------------------------------------------------------------------------

function getAuthJsonPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "auth.json");
}

function readAuthJson(): Record<string, unknown> {
  const authPath = getAuthJsonPath();
  try {
    if (fs.existsSync(authPath)) {
      return JSON.parse(fs.readFileSync(authPath, "utf-8")) as Record<
        string,
        unknown
      >;
    }
  } catch {
    // Fall through
  }
  return {};
}

function writeAuthJson(data: Record<string, unknown>): void {
  const authPath = getAuthJsonPath();
  const dir = path.dirname(authPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(authPath, JSON.stringify(data, null, 2), "utf-8");
}

function getAuthEntry(provider: string): Record<string, unknown> | undefined {
  const entry = readAuthJson()[provider];
  if (!entry || typeof entry !== "object") return undefined;
  return entry as Record<string, unknown>;
}

function removeAuthEntry(provider: string): void {
  const authData = readAuthJson();
  if (!(provider in authData)) return;
  delete authData[provider];
  writeAuthJson(authData);
}

type ProviderAuthState = "logged-in" | "refreshable" | "logged-out";

function getProviderAuthState(provider: string): ProviderAuthState {
  const entry = getAuthEntry(provider);
  if (!entry) return "logged-out";

  const access = entry.access;
  const refresh = entry.refresh;
  const expires = entry.expires;
  if (typeof access !== "string" || access.length === 0) {
    return typeof refresh === "string" && refresh.length > 0
      ? "refreshable"
      : "logged-out";
  }
  if (typeof expires !== "number" || Date.now() < expires) {
    return "logged-in";
  }
  return typeof refresh === "string" && refresh.length > 0
    ? "refreshable"
    : "logged-out";
}

function getProviderStatusLabel(provider: string): string {
  const state = getProviderAuthState(provider);
  if (state === "logged-in") return "logged in";
  if (state === "refreshable") {
    return "token expired — will refresh on next request";
  }
  return "not logged in";
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

async function generatePkce(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  const verifier = toBase64Url(bytes);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = toBase64Url(new Uint8Array(hash));

  return { verifier, challenge };
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Base URL normalization
// ---------------------------------------------------------------------------

function normalizeBaseUrl(resourceUrl?: string): string {
  if (!resourceUrl) {
    return QWEN_DEFAULT_BASE_URL;
  }

  const raw = resourceUrl.startsWith("http")
    ? resourceUrl
    : `https://${resourceUrl}`;
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase();

  if (hostname === "portal.qwen.ai") {
    url.pathname = "/v1";
  } else if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/compatible-mode/v1";
  } else if (!url.pathname.endsWith("/v1")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/v1`;
  }

  return url.toString().replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Payload normalization (Qwen Portal requires system messages as content parts)
// ---------------------------------------------------------------------------

interface QwenPortalMessage {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeQwenSystemContent(
  content: unknown,
): Array<{ type: "text"; text: string }> {
  if (Array.isArray(content)) {
    return content as Array<{ type: "text"; text: string }>;
  }
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return [{ type: "text", text: "" }];
}

export function normalizeQwenPortalPayload(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }

  if (
    typeof payload.model !== "string" ||
    !MODELS.some((model) => model.id === payload.model)
  ) {
    return payload;
  }

  const originalMessages = Array.isArray(payload.messages)
    ? (payload.messages as QwenPortalMessage[])
    : [];
  const messages = [...originalMessages];
  const systemIndex = messages.findIndex(
    (message) => isRecord(message) && message.role === "system",
  );

  if (systemIndex === -1) {
    messages.unshift({ role: "system", content: [{ type: "text", text: "" }] });
  } else {
    const systemMessage = messages[systemIndex];
    if (isRecord(systemMessage)) {
      messages[systemIndex] = {
        ...systemMessage,
        content: normalizeQwenSystemContent(systemMessage.content),
      };
    }
  }

  return { ...payload, messages };
}

// ---------------------------------------------------------------------------
// Token expiry computation
// ---------------------------------------------------------------------------

function computeExpiry(expiresInSeconds: number): number {
  return Date.now() + expiresInSeconds * 1000 - FIVE_MINUTES_MS;
}

// ---------------------------------------------------------------------------
// OAuth device flow
// ---------------------------------------------------------------------------

async function startDeviceFlow(
  signal?: AbortSignal,
): Promise<{ device: DeviceCodeResponse; verifier: string }> {
  const { verifier, challenge } = await generatePkce();

  const response = await fetch(QWEN_DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "x-request-id": crypto.randomUUID(),
    },
    body: new URLSearchParams({
      client_id: QWEN_CLIENT_ID,
      scope: QWEN_SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString(),
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Qwen device code request failed: ${response.status} ${await response.text()}`,
    );
  }

  const device = (await response.json()) as DeviceCodeResponse;
  if (
    !device.device_code ||
    !device.user_code ||
    !device.verification_uri ||
    !device.expires_in
  ) {
    throw new Error("Qwen device code response is missing required fields");
  }

  return { device, verifier };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Qwen login cancelled"));
      return;
    }

    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Qwen login cancelled"));
      },
      { once: true },
    );
  });
}

async function pollForToken(
  deviceCode: string,
  verifier: string,
  intervalSeconds: number | undefined,
  expiresIn: number,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<TokenResponse> {
  const deadline = Date.now() + expiresIn * 1000;
  let intervalMs = Math.max(
    1000,
    Math.floor(
      (intervalSeconds ?? QWEN_DEFAULT_POLL_INTERVAL_MS / 1000) * 1000,
    ),
  );
  let pollCount = 0;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error("Qwen login cancelled");
    }

    pollCount++;
    if (onProgress && pollCount % 10 === 0) {
      onProgress("Waiting for browser authorization…");
    }

    const response = await fetch(QWEN_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: QWEN_DEVICE_GRANT_TYPE,
        client_id: QWEN_CLIENT_ID,
        device_code: deviceCode,
        code_verifier: verifier,
      }).toString(),
    });

    const payload = (await response
      .json()
      .catch(() => null)) as TokenResponse | null;
    const error = payload?.error;
    const errorDescription = payload?.error_description;

    if (!response.ok) {
      if (error === "authorization_pending") {
        await sleep(intervalMs, signal);
        continue;
      }
      if (error === "slow_down") {
        intervalMs = Math.min(intervalMs + 5000, 10000);
        await sleep(intervalMs, signal);
        continue;
      }
      if (error === "expired_token") {
        throw new Error("Qwen device code expired; restart /login qwen-oauth");
      }
      if (error === "access_denied") {
        throw new Error("Qwen authorization was denied");
      }
      throw new Error(
        `Qwen token request failed: ${response.status} ${error ?? response.statusText} ${errorDescription ?? ""}`,
      );
    }

    if (payload?.access_token) {
      return payload;
    }

    throw new Error("Qwen token response did not include an access token");
  }

  throw new Error("Qwen login timed out");
}

// ---------------------------------------------------------------------------
// Public login/refresh (non-profiles mode)
// ---------------------------------------------------------------------------

export async function loginQwen(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  if (callbacks.signal?.aborted) {
    throw new Error("Qwen login cancelled");
  }

  const { device, verifier } = await startDeviceFlow(callbacks.signal);
  const authUrl = device.verification_uri_complete || device.verification_uri;
  const instructions = device.verification_uri_complete
    ? undefined
    : `Enter code: ${device.user_code}`;

  callbacks.onAuth({ url: authUrl, instructions });

  const token = await pollForToken(
    device.device_code,
    verifier,
    device.interval,
    device.expires_in,
    callbacks.signal,
    callbacks.onProgress,
  );
  return {
    refresh: token.refresh_token || "",
    access: token.access_token,
    expires: computeExpiry(token.expires_in),
    enterpriseUrl: token.resource_url,
  };
}

export async function refreshQwenToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (!credentials.refresh) {
    throw new Error(
      "Qwen OAuth refresh token is missing; run /login qwen-oauth again",
    );
  }

  const response = await fetch(QWEN_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh,
      client_id: QWEN_CLIENT_ID,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(
      `Qwen token refresh failed: ${response.status} ${await response.text()}`,
    );
  }

  const token = (await response.json()) as TokenResponse;
  if (!token.access_token) {
    throw new Error("Qwen refresh response did not include an access token");
  }

  return {
    refresh: token.refresh_token || credentials.refresh,
    access: token.access_token,
    expires: computeExpiry(token.expires_in),
    enterpriseUrl: token.resource_url ?? credentials.enterpriseUrl,
  };
}

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

const PROVIDER_MODELS = MODELS.map((model) => ({
  id: model.id,
  name: model.name,
  reasoning: model.reasoning,
  input: model.input,
  cost: ZERO_COST,
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
  compat: {
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
    ...(model.reasoning ? { thinkingFormat: "qwen" as const } : {}),
  },
}));

function getProviderHeaders(): Record<string, string> {
  return {
    "X-DashScope-AuthType": "qwen-oauth",
    "X-DashScope-UserAgent": QWEN_PORTAL_USER_AGENT,
    "User-Agent": QWEN_PORTAL_USER_AGENT,
  };
}

function registerAccountProvider(
  pi: ExtensionAPI,
  account: ManagedAccount,
): void {
  pi.registerProvider(account.provider, {
    baseUrl: QWEN_DEFAULT_BASE_URL,
    apiKey: `QWEN_OAUTH_${account.provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`,
    api: "openai-completions",
    headers: getProviderHeaders(),
    models: PROVIDER_MODELS,
    oauth: {
      name: getProviderOAuthName(account),
      login: loginQwen,
      refreshToken: refreshQwenToken,
      getApiKey: (credentials) => credentials.access,
      modifyModels: (models, credentials) => {
        const baseUrl = normalizeBaseUrl(
          credentials.enterpriseUrl as string | undefined,
        );
        return models.map((model) =>
          model.provider === account.provider ? { ...model, baseUrl } : model,
        );
      },
    },
  });
}

function refreshModelRegistry(ctx: ExtensionContext): void {
  const modelRegistry = (
    ctx as unknown as {
      modelRegistry?: { refresh?: () => void };
    }
  ).modelRegistry;
  modelRegistry?.refresh?.();
}

function unregisterAccountProvider(pi: ExtensionAPI, provider: string): void {
  const api = pi as unknown as { unregisterProvider?: (name: string) => void };
  api.unregisterProvider?.(provider);
}

function showLoginInstructions(
  account: ManagedAccount,
  ctx: ExtensionContext,
): void {
  ctx.ui.notify(
    `Use /login and select "${getProviderOAuthName(account)}" to authenticate ${account.label}.`,
    "info",
  );
}

function listAccountLines(store: AccountStoreData): string[] {
  return store.accounts.map(
    (account) =>
      `${account.label} (${account.provider}) - ${getProviderStatusLabel(account.provider)}`,
  );
}

async function openAccountPanel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  while (true) {
    const store = loadAccountStore();
    const accountOptions = store.accounts.map(
      (account) =>
        `${account.label}  [${account.provider}]  ${getProviderStatusLabel(account.provider)}`,
    );
    const selected = await ctx.ui.select("Qwen OAuth Accounts", [
      ...accountOptions,
      "───",
      "Add new account",
    ]);
    if (!selected) return;
    if (selected === "───") continue;

    if (selected === "Add new account") {
      const label = await ctx.ui.input(
        "Display label:",
        `Account ${store.accounts.length + 1}`,
      );
      if (!label?.trim()) continue;
      const account = addAccount(store, label.trim());
      registerAccountProvider(pi, account);
      refreshModelRegistry(ctx);
      ctx.ui.notify(
        `Added account: ${account.label} (${account.provider})`,
        "info",
      );
      showLoginInstructions(account, ctx);
      continue;
    }

    const selectedIndex = accountOptions.indexOf(selected);
    const account = store.accounts[selectedIndex];
    if (!account) continue;

    const actions = [
      getProviderAuthState(account.provider) === "logged-out"
        ? "Login"
        : "Login again",
      "Rename label",
      !isDefaultProvider(account.provider) ? "Remove account" : null,
    ].filter(Boolean) as string[];
    const action = await ctx.ui.select(
      `${account.label} (${account.provider})`,
      actions,
    );
    if (!action) continue;

    if (action.includes("Login")) {
      showLoginInstructions(account, ctx);
      continue;
    }

    if (action.includes("Rename")) {
      const nextLabel = await ctx.ui.input("New label:", account.label);
      if (!nextLabel?.trim()) continue;
      renameAccountLabel(store, account.provider, nextLabel.trim());
      const updated = getAccount(loadAccountStore(), account.provider);
      if (updated) {
        registerAccountProvider(pi, updated);
      }
      refreshModelRegistry(ctx);
      ctx.ui.notify(
        `Renamed ${account.provider} to ${nextLabel.trim()}`,
        "info",
      );
      continue;
    }

    if (action.includes("Remove")) {
      const confirmed = await ctx.ui.confirm(
        `Remove account "${account.label}"?`,
        `This will delete the saved login for ${account.provider}.`,
      );
      if (!confirmed) continue;
      removeAccount(store, account.provider);
      removeAuthEntry(account.provider);
      unregisterAccountProvider(pi, account.provider);
      refreshModelRegistry(ctx);
      ctx.ui.notify(`Removed account: ${account.provider}`, "info");
    }
  }
}

function registerAccountCommand(pi: ExtensionAPI): void {
  pi.registerCommand("qwen-profile", {
    description: "Manage Qwen OAuth accounts",
    getArgumentCompletions: (prefix: string) => {
      const store = loadAccountStore();
      const trimmed = prefix.trim();
      if (!trimmed) {
        return ["list", "add", "login", "rename", "remove"].map((value) => ({
          value,
          label: value,
        }));
      }

      const parts = trimmed.split(/\s+/);
      if (parts.length === 1) {
        const matches = ["list", "add", "login", "rename", "remove"].filter(
          (value) => value.startsWith(parts[0]),
        );
        return matches.length > 0
          ? matches.map((value) => ({ value, label: value }))
          : null;
      }

      if (
        parts[0] === "login" ||
        parts[0] === "rename" ||
        parts[0] === "remove"
      ) {
        const providerPrefix = parts[1] || "";
        const matches = store.accounts
          .map((account) => account.provider)
          .filter((provider) => provider.startsWith(providerPrefix));
        return matches.length > 0
          ? matches.map((provider) => ({
              value: `${parts[0]} ${provider}`,
              label: provider,
            }))
          : null;
      }

      return null;
    },
    handler: async (args: string, ctx) => {
      const store = loadAccountStore();
      const trimmed = args.trim();

      if (!ctx.hasUI) {
        ctx.ui.notify(listAccountLines(store).join("\n"), "info");
        return;
      }

      if (!trimmed) {
        await openAccountPanel(pi, ctx);
        return;
      }

      const parts = trimmed.split(/\s+/);
      const subcommand = parts[0]?.toLowerCase();

      if (subcommand === "list") {
        ctx.ui.notify(listAccountLines(store).join("\n"), "info");
        return;
      }

      if (subcommand === "add") {
        const rawLabel = parts.slice(1).join(" ");
        const label = rawLabel || `Account ${store.accounts.length + 1}`;
        const account = addAccount(store, label);
        registerAccountProvider(pi, account);
        refreshModelRegistry(ctx);
        ctx.ui.notify(
          `Added account: ${account.label} (${account.provider})`,
          "info",
        );
        showLoginInstructions(account, ctx);
        return;
      }

      if (subcommand === "login" && parts[1]) {
        const account = getAccount(store, parts[1]);
        if (!account) {
          ctx.ui.notify(`Unknown account: ${parts[1]}`, "error");
          return;
        }
        showLoginInstructions(account, ctx);
        return;
      }

      if (subcommand === "rename" && parts[1] && parts[2]) {
        const provider = parts[1];
        const label = parts.slice(2).join(" ");
        if (!renameAccountLabel(store, provider, label)) {
          ctx.ui.notify(`Account "${provider}" not found`, "error");
          return;
        }
        const account = getAccount(loadAccountStore(), provider);
        if (account) {
          registerAccountProvider(pi, account);
        }
        refreshModelRegistry(ctx);
        ctx.ui.notify(`Renamed ${provider} to: ${label}`, "info");
        return;
      }

      if (subcommand === "remove" && parts[1]) {
        const provider = parts[1];
        if (!removeAccount(store, provider)) {
          ctx.ui.notify(
            isDefaultProvider(provider)
              ? "Cannot remove the default account"
              : `Account "${provider}" not found`,
            isDefaultProvider(provider) ? "warning" : "error",
          );
          return;
        }
        removeAuthEntry(provider);
        unregisterAccountProvider(pi, provider);
        refreshModelRegistry(ctx);
        ctx.ui.notify(`Removed account: ${provider}`, "info");
        return;
      }

      ctx.ui.notify(
        "Usage: /qwen-profile [list | add [label] | login <provider> | rename <provider> <label> | remove <provider>]",
        "info",
      );
    },
  });
}

function registerNormalMode(pi: ExtensionAPI): void {
  const baseAccount =
    getAccount(loadAccountStore(), "qwen-oauth") ||
    getDefaultAccountStoreData().accounts[0];

  registerAccountProvider(pi, baseAccount);
}

function registerAccountMode(pi: ExtensionAPI): void {
  const store = loadAccountStore();
  for (const account of store.accounts) {
    registerAccountProvider(pi, account);
  }
  registerAccountCommand(pi);
}

export default function registerQwenOAuthProvider(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event) =>
    normalizeQwenPortalPayload(event.payload),
  );

  if (profilesEnabled()) {
    registerAccountMode(pi);
    return;
  }

  registerNormalMode(pi);
}
