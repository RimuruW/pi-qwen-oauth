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
 * Multi-profile mode (PI_QWEN_OAUTH_PROFILES=true):
 * Manages multiple Qwen OAuth profiles with independent credentials.
 * Use /qwen-profile to switch, login, and manage profiles.
 */

import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QWEN_DEVICE_CODE_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/device/code";
const QWEN_TOKEN_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/token";
const QWEN_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
const QWEN_SCOPE = "openid profile email model.completion";
const QWEN_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const QWEN_DEFAULT_BASE_URL = "https://portal.qwen.ai/v1";
const QWEN_DEFAULT_POLL_INTERVAL_MS = 2000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const QWEN_PORTAL_USER_AGENT = "QwenCode/0.14.0 (darwin; arm64)";
const PROFILES_ENABLED = process.env.PI_QWEN_OAUTH_PROFILES === "true";

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
// Profile store (multi-profile mode)
// ---------------------------------------------------------------------------

interface ProfileDef {
	key: string;
	label: string;
}

interface ProfileCredential {
	access: string;
	refresh: string;
	expires: number;
	enterpriseUrl?: string;
}

interface ProfileStoreData {
	version: number;
	activeProfile: string;
	profiles: ProfileDef[];
	credentials: Record<string, ProfileCredential>;
}

function getProfilesFilePath(): string {
	return path.join(os.homedir(), ".pi", "agent", "qwen-oauth-profiles.json");
}

function getDefaultStoreData(): ProfileStoreData {
	return {
		version: 1,
		activeProfile: "default",
		profiles: [{ key: "default", label: "Default" }],
		credentials: {},
	};
}

function loadProfileStore(): ProfileStoreData {
	const filePath = getProfilesFilePath();
	try {
		if (fs.existsSync(filePath)) {
			const text = fs.readFileSync(filePath, "utf-8");
			const parsed = JSON.parse(text) as Partial<ProfileStoreData>;
			return {
				...getDefaultStoreData(),
				...parsed,
				profiles: parsed.profiles ?? getDefaultStoreData().profiles,
				credentials: parsed.credentials ?? {},
			};
		}
	} catch {
		// Fall through to defaults
	}
	return getDefaultStoreData();
}

function saveProfileStore(data: ProfileStoreData): void {
	const filePath = getProfilesFilePath();
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function getProfile(store: ProfileStoreData, key: string): ProfileDef | undefined {
	return store.profiles.find((p) => p.key === key);
}

function getActiveProfile(store: ProfileStoreData): ProfileDef | undefined {
	return getProfile(store, store.activeProfile);
}

function getCredential(store: ProfileStoreData, key: string): ProfileCredential | undefined {
	return store.credentials[key];
}

function isProfileLoggedIn(store: ProfileStoreData, key: string): boolean {
	const cred = getCredential(store, key);
	return !!cred && cred.access && Date.now() < cred.expires;
}

function updateCredential(store: ProfileStoreData, key: string, cred: ProfileCredential): void {
	store.credentials[key] = cred;
	saveProfileStore(store);
}

function setActiveProfile(store: ProfileStoreData, key: string): boolean {
	if (!getProfile(store, key)) return false;
	store.activeProfile = key;
	saveProfileStore(store);
	return true;
}

function removeProfile(store: ProfileStoreData, key: string): boolean {
	if (key === "default" && store.profiles.length <= 1) return false;
	const idx = store.profiles.findIndex((p) => p.key === key);
	if (idx < 0) return false;
	store.profiles.splice(idx, 1);
	delete store.credentials[key];
	if (store.activeProfile === key) {
		store.activeProfile = store.profiles[0]?.key ?? "default";
	}
	saveProfileStore(store);
	return true;
}

function addProfile(store: ProfileStoreData, key: string, label?: string): boolean {
	if (getProfile(store, key)) return false;
	store.profiles.push({ key, label: label || key });
	saveProfileStore(store);
	return true;
}

function renameProfileLabel(store: ProfileStoreData, key: string, label: string): boolean {
	const profile = getProfile(store, key);
	if (!profile) return false;
	profile.label = label;
	saveProfileStore(store);
	return true;
}

// ---------------------------------------------------------------------------
// Migration: import old auth.json credentials into default profile
// ---------------------------------------------------------------------------

function migrateOldCredentials(store: ProfileStoreData): boolean {
	// Only migrate if default profile has no credentials yet
	if (isProfileLoggedIn(store, "default") || store.credentials["default"]?.refresh) {
		return false;
	}

	// Try to read pi's auth.json
	const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	try {
		if (!fs.existsSync(authPath)) return false;
		const text = fs.readFileSync(authPath, "utf-8");
		const auth = JSON.parse(text) as Record<string, unknown>;
		const qwenCred = auth["qwen-oauth"];
		if (!qwenCred || typeof qwenCred !== "object" || (qwenCred as Record<string, unknown>).type !== "oauth") {
			return false;
		}
		const oauth = qwenCred as Record<string, unknown>;
		const access = oauth.access as string | undefined;
		const refresh = oauth.refresh as string | undefined;
		const expires = oauth.expires as number | undefined;
		if (!access || !refresh || !expires) return false;

		store.credentials["default"] = {
			access,
			refresh,
			expires,
			enterpriseUrl: oauth.enterpriseUrl as string | undefined,
		};
		saveProfileStore(store);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Migration: profile mode -> normal mode (env var removed)
// ---------------------------------------------------------------------------

function migrateProfileToAuth(): boolean {
	const store = loadProfileStore();
	const active = getActiveProfile(store);
	if (!active) return false;

	const cred = getCredential(store, active.key);
	if (!cred || !cred.access || !cred.refresh) return false;

	const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	const authData: Record<string, unknown> = fs.existsSync(authPath)
		? JSON.parse(fs.readFileSync(authPath, "utf-8"))
		: {};

	// Skip if auth.json already has the same credentials (no-op migration)
	const existing = authData["qwen-oauth"];
	if (existing && typeof existing === "object" && (existing as Record<string, unknown>).access === cred.access) {
		return false;
	}

	authData["qwen-oauth"] = {
		type: "oauth",
		access: cred.access,
		refresh: cred.refresh,
		expires: cred.expires,
		enterpriseUrl: cred.enterpriseUrl,
	};

	const dir = path.dirname(authPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(authPath, JSON.stringify(authData, null, 2), "utf-8");
	return true;
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);

	const verifier = toBase64Url(bytes);
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
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

function openBrowser(url: string): void {
	const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	// Use execFile to avoid shell injection; on Windows cmd needs /c prefix
	const args = openCmd === "cmd" ? ["/c", "start", url] : [url];
	execFile(openCmd, args);
}

// ---------------------------------------------------------------------------
// Interactive login helper (shared across commands and TUI panel)
// ---------------------------------------------------------------------------

async function interactiveLogin(
	store: ProfileStoreData,
	profileKey: string,
	label: string,
	ctx: ExtensionContext,
): Promise<void> {
	ctx.ui.notify(`Starting login for ${label}…`, "info");
	try {
		await loginProfile(store, profileKey, {
			onAuth: ({ url }) => {
				openBrowser(url);
				ctx.ui.notify(`Opened browser. If login didn't complete, visit: ${url}`, "info");
			},
			onPrompt: async ({ message }) => (await ctx.ui.input(message)) || "",
			signal: ctx.signal,
		});
		ctx.ui.notify(`Logged in to ${label}`, "info");
	} catch (error) {
		ctx.ui.notify(`Login failed for ${label}: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

function normalizeBaseUrl(resourceUrl?: string): string {
	if (!resourceUrl) {
		return QWEN_DEFAULT_BASE_URL;
	}

	const raw = resourceUrl.startsWith("http") ? resourceUrl : `https://${resourceUrl}`;
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

function normalizeQwenSystemContent(content: unknown): Array<{ type: "text"; text: string }> {
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

	if (typeof payload.model !== "string" || !MODELS.some((model) => model.id === payload.model)) {
		return payload;
	}

	const originalMessages = Array.isArray(payload.messages) ? (payload.messages as QwenPortalMessage[]) : [];
	const messages = [...originalMessages];
	const systemIndex = messages.findIndex((message) => isRecord(message) && message.role === "system");

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

async function startDeviceFlow(signal?: AbortSignal): Promise<{ device: DeviceCodeResponse; verifier: string }> {
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
		throw new Error(`Qwen device code request failed: ${response.status} ${await response.text()}`);
	}

	const device = (await response.json()) as DeviceCodeResponse;
	if (!device.device_code || !device.user_code || !device.verification_uri || !device.expires_in) {
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
	let intervalMs = Math.max(1000, Math.floor((intervalSeconds ?? QWEN_DEFAULT_POLL_INTERVAL_MS / 1000) * 1000));
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

		const payload = (await response.json().catch(() => null)) as TokenResponse | null;
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
			throw new Error(`Qwen token request failed: ${response.status} ${error ?? response.statusText} ${errorDescription ?? ""}`);
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

export async function loginQwen(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	if (callbacks.signal?.aborted) {
		throw new Error("Qwen login cancelled");
	}

	const { device, verifier } = await startDeviceFlow(callbacks.signal);
	const authUrl = device.verification_uri_complete || device.verification_uri;
	const instructions = device.verification_uri_complete ? undefined : `Enter code: ${device.user_code}`;

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

export async function refreshQwenToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	if (!credentials.refresh) {
		throw new Error("Qwen OAuth refresh token is missing; run /login qwen-oauth again");
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
		throw new Error(`Qwen token refresh failed: ${response.status} ${await response.text()}`);
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
// Profile-mode login/refresh
// ---------------------------------------------------------------------------

async function loginProfile(store: ProfileStoreData, profileKey: string, callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { device, verifier } = await startDeviceFlow(callbacks.signal);
	const authUrl = device.verification_uri_complete || device.verification_uri;
	const instructions = device.verification_uri_complete ? undefined : `Enter code: ${device.user_code}`;

	callbacks.onAuth({ url: authUrl, instructions });

	const token = await pollForToken(
		device.device_code,
		verifier,
		device.interval,
		device.expires_in,
		callbacks.signal,
		callbacks.onProgress,
	);

	const cred: ProfileCredential = {
		access: token.access_token,
		refresh: token.refresh_token || "",
		expires: computeExpiry(token.expires_in),
		enterpriseUrl: token.resource_url,
	};
	updateCredential(store, profileKey, cred);

	return {
		refresh: cred.refresh,
		access: cred.access,
		expires: cred.expires,
		enterpriseUrl: cred.enterpriseUrl,
	};
}

async function refreshProfileCredential(store: ProfileStoreData, profileKey: string): Promise<ProfileCredential> {
	const existing = getCredential(store, profileKey);
	if (!existing?.refresh) {
		throw new Error(`Profile "${profileKey}" has no refresh token; run /qwen-profile login ${profileKey}`);
	}

	const response = await fetch(QWEN_TOKEN_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: existing.refresh,
			client_id: QWEN_CLIENT_ID,
		}).toString(),
	});

	if (!response.ok) {
		throw new Error(`Qwen token refresh failed for profile "${profileKey}": ${response.status} ${await response.text()}`);
	}

	const token = (await response.json()) as TokenResponse;
	if (!token.access_token) {
		throw new Error(`Qwen refresh response for profile "${profileKey}" did not include an access token`);
	}

	const cred: ProfileCredential = {
		access: token.access_token,
		refresh: token.refresh_token || existing.refresh,
		expires: computeExpiry(token.expires_in),
		enterpriseUrl: token.resource_url ?? existing.enterpriseUrl,
	};
	updateCredential(store, profileKey, cred);
	return cred;
}

// ---------------------------------------------------------------------------
// Profile-mode: ensure valid token (refresh if needed)
// ---------------------------------------------------------------------------

async function ensureValidProfileToken(store: ProfileStoreData, profileKey: string): Promise<ProfileCredential> {
	const cred = getCredential(store, profileKey);
	if (!cred || !cred.access) {
		throw new Error(`Profile "${profileKey}" is not logged in. Run /qwen-profile login ${profileKey} or /login qwen-oauth.`);
	}

	// Token still valid?
	if (Date.now() < cred.expires) {
		return cred;
	}

	// Needs refresh
	return refreshProfileCredential(store, profileKey);
}

// ---------------------------------------------------------------------------
// Profile-mode: custom streamSimple
//
// We can't delegate to pi-ai's streamSimpleOpenAICompletions (not exported).
// Instead, we build the request, fetch Qwen Portal, parse SSE, and emit
// events via createAssistantMessageEventStream.
// ---------------------------------------------------------------------------

function buildOpenAIMessages(context: { messages: Array<{ role: string; content: unknown; toolCallId?: string; toolName?: string }> }): Array<Record<string, unknown>> {
	const messages: Array<Record<string, unknown>> = [];
	for (const msg of context.messages) {
		if (msg.role === "toolResult") {
			messages.push({
				role: "tool",
				tool_call_id: msg.toolCallId,
				content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
			});
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const toolCalls: Array<Record<string, unknown>> = [];
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block && typeof block === "object") {
						const b = block as Record<string, unknown>;
						if (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) {
							textParts.push(b.text);
						} else if (b.type === "toolCall") {
							toolCalls.push({
								id: (b.id as string) || "",
								type: "function",
								function: {
									name: (b.name as string) || "",
									arguments: typeof b.arguments === "object" ? JSON.stringify(b.arguments) : (b.arguments as string) || "{}",
								},
							});
						}
					}
				}
			}
			const assistantMsg: Record<string, unknown> = { role: "assistant" };
			// OpenAI Chat Completions standard: assistant content is a plain string
			if (textParts.length > 0) assistantMsg.content = textParts.join("");
			if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
			// Skip assistant messages with no content and no tool calls
			if (assistantMsg.content === undefined && !assistantMsg.tool_calls) continue;
			messages.push(assistantMsg);
		} else if (msg.role === "system") {
			// System messages: normalize content to content-parts array
			messages.push({
				role: "system",
				content: normalizeQwenSystemContent(msg.content),
			});
		} else {
			// user: collapse content-parts array to plain string
			let userContent = msg.content;
			if (Array.isArray(userContent)) {
				const texts: string[] = [];
				for (const part of userContent) {
					if (part && typeof part === "object") {
						const p = part as Record<string, unknown>;
						if (p.type === "text" && typeof p.text === "string") {
							texts.push(p.text);
						}
					}
				}
				userContent = texts.join("");
			}
			messages.push({
				role: "user",
				content: userContent,
			});
		}
	}
	return messages;
}

function buildRequestPayload(
	modelId: string,
	context: { messages: Array<{ role: string; content: unknown }>; systemPrompt?: string },
	options?: { temperature?: number; maxTokens?: number; reasoning?: string },
): Record<string, unknown> {
	const messages = buildOpenAIMessages(context);

	// If there's a systemPrompt and no system message in the conversation, prepend it
	const hasSystem = messages.some((m) => m.role === "system");
	if (context.systemPrompt && !hasSystem) {
		messages.unshift({ role: "system", content: context.systemPrompt });
	}

	const payload: Record<string, unknown> = {
		model: modelId,
		messages,
		stream: true,
	};

	if (options?.temperature !== undefined) payload.temperature = options.temperature;
	if (options?.maxTokens !== undefined) payload.max_tokens = options.maxTokens;

	// Qwen Portal: enable_thinking as boolean for reasoning models
	if (options?.reasoning && options.reasoning !== "off") {
		payload.enable_thinking = true;
	}

	return payload;
}

function createQwenStream(
	modelId: string,
	baseUrl: string,
	headers: Record<string, string> | undefined,
	context: { messages: Array<{ role: string; content: unknown }>; systemPrompt?: string },
	token: string,
	options?: { temperature?: number; maxTokens?: number; reasoning?: string; signal?: AbortSignal },
) {
	const stream = createAssistantMessageEventStream();

	const output = {
		role: "assistant" as const,
		content: [] as Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>,
		api: "openai-completions" as const,
		provider: "qwen-oauth",
		model: modelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};

	(async () => {
		try {
			const rawPayload = buildRequestPayload(modelId, context, options);
			const payload = normalizeQwenPortalPayload(rawPayload) as Record<string, unknown>;

			const requestHeaders: Record<string, string> = {
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				Authorization: `Bearer ${token}`,
			};
			if (headers) {
				for (const [k, v] of Object.entries(headers)) {
					requestHeaders[k] = v;
				}
			}

			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: requestHeaders,
				body: JSON.stringify(payload),
				signal: options?.signal,
			});

			if (!response.ok) {
				const body = await response.text();
				throw new Error(`Qwen API error: ${response.status} ${body}`);
			}

			if (!response.body) {
				throw new Error("Qwen API response body is null");
			}

			stream.push({ type: "start", partial: { ...output, content: [...output.content] } });

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let textContentIndex = -1;
			let thinkingContentIndex = -1;
			let currentToolCallIndex = -1;
			let currentToolCall: { id: string; name: string; arguments: string } | null = null;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith(":")) continue;

					if (!trimmed.startsWith("data: ")) continue;
					const data = trimmed.slice(6);
					if (data === "[DONE]") {
						stream.push({
							type: "done",
							reason: output.stopReason as "stop" | "length" | "toolUse",
							message: { ...output, content: [...output.content] },
						});
						stream.end({ ...output, content: [...output.content] });
						return;
					}

					let chunk: Record<string, unknown>;
					try {
						chunk = JSON.parse(data) as Record<string, unknown>;
					} catch {
						continue;
					}

					const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
					if (!choices || choices.length === 0) continue;

					const delta = choices[0]?.delta as Record<string, unknown> | undefined;
					if (!delta) continue;

					const finishReason = choices[0]?.finish_reason as string | undefined;
					if (finishReason) {
						if (finishReason === "stop") output.stopReason = "stop";
						else if (finishReason === "length") output.stopReason = "length";
						else if (finishReason === "tool_calls") output.stopReason = "toolUse";
					}

					// Usage (sometimes in the last chunk)
					const usage = chunk.usage as Record<string, number> | undefined;
					if (usage) {
						output.usage.input = usage.prompt_tokens ?? output.usage.input;
						output.usage.output = usage.completion_tokens ?? output.usage.output;
						output.usage.cacheRead = usage.prompt_tokens_details?.cached_tokens ? 0 : (usage.cache_read_tokens ?? 0);
						output.usage.cacheWrite = usage.cache_write_tokens ?? 0;
						output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					}

					// Text content
					if (typeof delta.content === "string" && delta.content) {
						if (textContentIndex < 0 || output.content[textContentIndex]?.type !== "text") {
							output.content.push({ type: "text", text: "" });
							textContentIndex = output.content.length - 1;
							stream.push({ type: "text_start", contentIndex: textContentIndex, partial: { ...output, content: [...output.content] } });
						}
						const textBlock = output.content[textContentIndex];
						if (textBlock && textBlock.type === "text") {
							textBlock.text += delta.content;
							stream.push({ type: "text_delta", contentIndex: textContentIndex, delta: delta.content as string, partial: { ...output, content: [...output.content] } });
						}
					}

					// Thinking content (Qwen-style: delta.reasoning_content or delta.reasoning)
					const thinkingDelta = (delta.reasoning_content as string) || (delta.reasoning as string);
					if (thinkingDelta) {
						if (thinkingContentIndex < 0 || output.content[thinkingContentIndex]?.type !== "thinking") {
							output.content.push({ type: "thinking", thinking: "" });
							thinkingContentIndex = output.content.length - 1;
							stream.push({ type: "thinking_start", contentIndex: thinkingContentIndex, partial: { ...output, content: [...output.content] } });
						}
						const thinkingBlock = output.content[thinkingContentIndex];
						if (thinkingBlock && thinkingBlock.type === "thinking") {
							thinkingBlock.thinking += thinkingDelta;
							stream.push({ type: "thinking_delta", contentIndex: thinkingContentIndex, delta: thinkingDelta, partial: { ...output, content: [...output.content] } });
						}
					}

					// Tool calls
					const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
					if (toolCalls) {
						for (const tc of toolCalls) {
							const index = tc.index as number | undefined;
							if (index !== undefined && index !== currentToolCallIndex) {
								// End previous tool call
								if (currentToolCall && currentToolCallIndex >= 0) {
									const prevBlock = output.content[currentToolCallIndex];
									if (prevBlock && prevBlock.type === "toolCall") {
										try {
											prevBlock.arguments = JSON.parse(currentToolCall.arguments);
										} catch {
											prevBlock.arguments = {};
										}
										stream.push({
											type: "toolcall_end",
											contentIndex: currentToolCallIndex,
											toolCall: {
												type: "toolCall",
												id: currentToolCall.id,
												name: currentToolCall.name,
												arguments: prevBlock.arguments as Record<string, unknown>,
											},
											partial: { ...output, content: [...output.content] },
										});
									}
								}

								// Start new tool call
								const id = (tc.id as string) || (currentToolCall?.id) || "";
								const fn = tc.function as Record<string, unknown> | undefined;
								const name = (fn?.name as string) || "";
								const args = (fn?.arguments as string) || "";
								output.content.push({ type: "toolCall", id, name, arguments: {} as Record<string, unknown> });
								currentToolCallIndex = output.content.length - 1;
								currentToolCall = { id, name, arguments: args };

								stream.push({
									type: "toolcall_start",
									contentIndex: currentToolCallIndex,
									partial: { ...output, content: [...output.content] },
								});
							} else if (currentToolCall) {
								const fn = tc.function as Record<string, unknown> | undefined;
								if (fn?.arguments) {
									currentToolCall.arguments += fn.arguments as string;
									const block = output.content[currentToolCallIndex];
									if (block) {
										stream.push({
											type: "toolcall_delta",
											contentIndex: currentToolCallIndex,
											delta: fn.arguments as string,
											partial: { ...output, content: [...output.content] },
										});
									}
								}
							}
						}
					}
				}
			}

			// End any in-progress tool call
			if (currentToolCall && currentToolCallIndex >= 0) {
				const block = output.content[currentToolCallIndex];
				if (block && block.type === "toolCall") {
					try {
						block.arguments = JSON.parse(currentToolCall.arguments);
					} catch {
						block.arguments = {};
					}
					stream.push({
						type: "toolcall_end",
						contentIndex: currentToolCallIndex,
						toolCall: {
							type: "toolCall",
							id: currentToolCall.id,
							name: currentToolCall.name,
							arguments: block.arguments as Record<string, unknown>,
						},
						partial: { ...output, content: [...output.content] },
					});
				}
			}

			// End text block if open
			const lastBlock = output.content[output.content.length - 1];
			if (lastBlock?.type === "text") {
				stream.push({
					type: "text_end",
					contentIndex: output.content.length - 1,
					content: lastBlock.text || "",
					partial: { ...output, content: [...output.content] },
				});
			} else if (lastBlock?.type === "thinking") {
				stream.push({
					type: "thinking_end",
					contentIndex: output.content.length - 1,
					content: lastBlock.thinking || "",
					partial: { ...output, content: [...output.content] },
				});
			}

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: { ...output, content: [...output.content] },
			});
			stream.end({ ...output, content: [...output.content] });
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" as const : "error" as const;
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({
				type: "error",
				reason: output.stopReason,
				error: { ...output, content: [...output.content] },
			});
			stream.end({ ...output, content: [...output.content] });
		}
	})();

	return stream;
}

// ---------------------------------------------------------------------------
// /qwen-profile command (profiles mode only)
// ---------------------------------------------------------------------------

function registerProfileCommand(pi: ExtensionAPI, store: ProfileStoreData): void {
	pi.registerCommand("qwen-profile", {
		description: "Manage Qwen OAuth profiles",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = prefix.trim();
			if (!trimmed) {
				return ["use", "login", "add", "rename", "remove", "list"].map((v) => ({ value: v, label: v }));
			}
			const parts = trimmed.split(/\s+/);
			if (parts.length === 1) {
				const matches = ["use", "login", "add", "rename", "remove", "list"].filter((v) => v.startsWith(parts[0]));
				return matches.length > 0 ? matches.map((v) => ({ value: v, label: v })) : null;
			}
			if (parts[0] === "use" || parts[0] === "login" || parts[0] === "rename" || parts[0] === "remove") {
				const profilePrefix = parts[1] || "";
				const matches = store.profiles
					.map((p) => p.key)
					.filter((k) => k.startsWith(profilePrefix));
				return matches.length > 0 ? matches.map((k) => ({ value: `${parts[0]} ${k}`, label: k })) : null;
			}
			return null;
		},
		handler: async (args: string, ctx) => {
			if (!ctx.hasUI) {
				// Non-interactive mode: print status
				const active = store.activeProfile;
				const lines = store.profiles.map((p) => {
					const loggedIn = isProfileLoggedIn(store, p.key);
					const activeMarker = p.key === active ? " [active]" : "";
					return `${p.label} (${p.key})${activeMarker} - ${loggedIn ? "logged in" : "not logged in"}`;
				});
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const trimmed = args.trim();
			if (!trimmed) {
				await openProfilePanel(ctx, store);
				return;
			}

			const parts = trimmed.split(/\s+/);
			const subcommand = parts[0]?.toLowerCase();

			if (subcommand === "list") {
				const active = store.activeProfile;
				const lines = store.profiles.map((p) => {
					const loggedIn = isProfileLoggedIn(store, p.key);
					const activeMarker = p.key === active ? " [active]" : "";
					return `${p.label} (${p.key})${activeMarker} - ${loggedIn ? "logged in" : "not logged in"}`;
				});
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (subcommand === "use" && parts[1]) {
				const key = parts[1];
				if (!getProfile(store, key)) {
					ctx.ui.notify(`Unknown profile: ${key}`, "error");
					return;
				}
				setActiveProfile(store, key);
				ctx.ui.notify(`Switched to profile: ${getProfile(store, key)?.label || key}`, "info");
				return;
			}

			if (subcommand === "login" && parts[1]) {
				const key = parts[1];
				const profile = getProfile(store, key);
				if (!profile) {
					ctx.ui.notify(`Unknown profile: ${key}`, "error");
					return;
				}
				try {
					await interactiveLogin(store, key, profile.label, ctx);
				} catch {
					// Error already handled by interactiveLogin
				}
				return;
			}

			if (subcommand === "add" && parts[1]) {
				const key = parts[1];
				const label = parts.slice(2).join(" ") || key;
				if (addProfile(store, key, label)) {
					ctx.ui.notify(`Added profile: ${label} (${key})`, "info");
					// Prompt to login
					const doLogin = await ctx.ui.confirm(`Login to ${label} now?`);
					if (doLogin) {
						await interactiveLogin(store, key, label, ctx);
					}
				} else {
					ctx.ui.notify(`Profile "${key}" already exists`, "warning");
				}
				return;
			}

			if (subcommand === "rename" && parts[1] && parts[2]) {
				const key = parts[1];
				const newLabel = parts.slice(2).join(" ");
				if (renameProfileLabel(store, key, newLabel)) {
					ctx.ui.notify(`Renamed ${key} to: ${newLabel}`, "info");
				} else {
					ctx.ui.notify(`Profile "${key}" not found`, "error");
				}
				return;
			}

			if (subcommand === "remove" && parts[1]) {
				const key = parts[1];
				if (key === "default" && store.profiles.length <= 1) {
					ctx.ui.notify("Cannot remove the last profile", "warning");
					return;
				}
				if (removeProfile(store, key)) {
					ctx.ui.notify(`Removed profile: ${key}`, "info");
				} else {
					ctx.ui.notify(`Profile "${key}" not found`, "error");
				}
				return;
			}

			ctx.ui.notify("Usage: /qwen-profile [list | use <key> | login <key> | add <key> [label] | rename <key> <label> | remove <key>]", "info");
		},
	});
}

// ---------------------------------------------------------------------------
// Profile management TUI panel
// ---------------------------------------------------------------------------

async function openProfilePanel(ctx: ExtensionContext, store: ProfileStoreData): Promise<void> {
	while (true) {
		const profiles = store.profiles;
		const active = store.activeProfile;

		const options = profiles.map((p) => {
			const loggedIn = isProfileLoggedIn(store, p.key);
			const activeMarker = p.key === active ? " ✓" : "";
			const status = loggedIn ? "logged in" : "not logged in";
			return `${p.label}${activeMarker}  [${p.key}]  ${status}`;
		});

		const menuOptions = [...options, "───", "Add new profile"];
		const selected = await ctx.ui.select("Qwen OAuth Profiles", menuOptions);
		if (!selected) return;

		// Check if user selected "Add new profile"
		if (selected === "Add new profile") {
			const key = await ctx.ui.input("Profile key (e.g. work, personal):");
			if (!key?.trim()) continue;
			if (getProfile(store, key.trim())) {
				ctx.ui.notify(`Profile "${key.trim()}" already exists`, "warning");
				continue;
			}
			const label = await ctx.ui.input("Display label:", key.trim());
			addProfile(store, key.trim(), label?.trim() || key.trim());
			ctx.ui.notify(`Added profile: ${label?.trim() || key.trim()} (${key.trim()})`, "info");
			// Prompt to login
			const doLogin = await ctx.ui.confirm(`Login to ${label?.trim() || key.trim()} now?`);
			if (doLogin) {
				await interactiveLogin(store, key.trim(), label?.trim() || key.trim(), ctx);
			}
			continue;
		}

		// Skip separator
		if (selected === "───") continue;

		// Find which profile was selected (match by key in the display)
		const selectedIndex = options.indexOf(selected);
		const profile = profiles[selectedIndex];
		if (!profile) continue;

		// Action panel for selected profile
		const actions = [
			profile.key === active ? `Currently active` : `Switch to this profile`,
			isProfileLoggedIn(store, profile.key) ? `Refresh token` : `Login`,
			`Rename label`,
			profile.key !== "default" ? `Remove profile` : null,
		].filter(Boolean) as string[];

		const action = await ctx.ui.select(`${profile.label} (${profile.key})`, actions);
		if (!action) continue;

		if (action.includes("Switch") || action.includes("active")) {
			setActiveProfile(store, profile.key);
			ctx.ui.notify(`Switched to profile: ${profile.label}`, "info");
			continue;
		}

		if (action.includes("Refresh") || action.includes("Login")) {
			await interactiveLogin(store, profile.key, profile.label, ctx);
			continue;
		}

		if (action.includes("Rename")) {
			const newLabel = await ctx.ui.input("New label:", profile.label);
			if (newLabel?.trim()) {
				renameProfileLabel(store, profile.key, newLabel.trim());
				ctx.ui.notify(`Renamed to: ${newLabel.trim()}`, "info");
			}
			continue;
		}

		if (action.includes("Remove")) {
			const confirmed = await ctx.ui.confirm(
				`Remove profile "${profile.label}"?`,
				"This will delete its credentials.",
			);
			if (confirmed) {
				removeProfile(store, profile.key);
				ctx.ui.notify(`Removed profile: ${profile.label}`, "info");
			}
			continue;
		}
	}
}

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

export default function registerQwenOAuthProvider(pi: ExtensionAPI) {
	// Always register payload normalization
	pi.on("before_provider_request", (event) => normalizeQwenPortalPayload(event.payload));

	if (PROFILES_ENABLED) {
		registerProfilesMode(pi);
	} else {
		registerNormalMode(pi);
	}
}

// ---------------------------------------------------------------------------
// Normal mode (unchanged behavior)
// ---------------------------------------------------------------------------

function registerNormalMode(pi: ExtensionAPI): void {
	// Migrate active profile credentials from profile store to auth.json
	const migrated = migrateProfileToAuth();

	if (migrated) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify("Migrated active Qwen OAuth profile credentials to normal mode.", "info");
		});
	}

	pi.registerProvider("qwen-oauth", {
		baseUrl: QWEN_DEFAULT_BASE_URL,
		apiKey: "QWEN_OAUTH_API_KEY",
		api: "openai-completions",
		headers: {
			"X-DashScope-AuthType": "qwen-oauth",
			"X-DashScope-UserAgent": QWEN_PORTAL_USER_AGENT,
			"User-Agent": QWEN_PORTAL_USER_AGENT,
		},
		models: MODELS.map((model) => ({
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
		})),
		oauth: {
			name: "Qwen OAuth",
			login: loginQwen,
			refreshToken: refreshQwenToken,
			getApiKey: (credentials) => credentials.access,
			modifyModels: (models, credentials) => {
				const baseUrl = normalizeBaseUrl(credentials.enterpriseUrl as string | undefined);
				return models.map((model) => (model.provider === "qwen-oauth" ? { ...model, baseUrl } : model));
			},
		},
	});
}

// ---------------------------------------------------------------------------
// Profiles mode
// ---------------------------------------------------------------------------

function registerProfilesMode(pi: ExtensionAPI): void {
	// Load and migrate profile store
	const store = loadProfileStore();
	const migrated = migrateOldCredentials(store);

	// Register /qwen-profile command
	registerProfileCommand(pi, store);

	// Notify about active profile on session start
	pi.on("session_start", async (_event, ctx) => {
		if (migrated) {
			ctx.ui.notify("Imported existing Qwen OAuth login into profile \"Default\".", "info");
		}
		const active = getActiveProfile(store);
		const loggedIn = active ? isProfileLoggedIn(store, active.key) : false;
		if (active) {
			ctx.ui.setStatus("qwen-oauth-profiles", `Qwen: ${active.label}${loggedIn ? "" : " (not logged in)"}`);
		}
	});

	// Update status after each turn
	pi.on("turn_end", (_event, ctx) => {
		const active = getActiveProfile(store);
		const loggedIn = active ? isProfileLoggedIn(store, active.key) : false;
		if (active) {
			ctx.ui.setStatus("qwen-oauth-profiles", `Qwen: ${active.label}${loggedIn ? "" : " (not logged in)"}`);
		}
	});

	// Register provider with custom streamSimple
	pi.registerProvider("qwen-oauth", {
		baseUrl: QWEN_DEFAULT_BASE_URL,
		apiKey: "QWEN_OAUTH_PLACEHOLDER",
		api: "openai-completions",
		headers: {
			"X-DashScope-AuthType": "qwen-oauth",
			"X-DashScope-UserAgent": QWEN_PORTAL_USER_AGENT,
			"User-Agent": QWEN_PORTAL_USER_AGENT,
		},
		models: MODELS.map((model) => ({
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
		})),
		streamSimple: (model, context, options) => {
			// Re-read store to pick up changes from other sessions/commands
			const currentStore = loadProfileStore();
			const activeProfile = getActiveProfile(currentStore);
			if (!activeProfile) {
				throw new Error("No active Qwen OAuth profile configured.");
			}

			// Get or refresh token
			const tokenPromise = ensureValidProfileToken(currentStore, activeProfile.key);

			// Build a wrapper stream that waits for the token then creates the real stream
			const wrapper = createAssistantMessageEventStream();

			tokenPromise.then((cred) => {
				const baseUrl = cred.enterpriseUrl ? normalizeBaseUrl(cred.enterpriseUrl) : QWEN_DEFAULT_BASE_URL;

				// Convert pi context messages to the format buildOpenAIMessages expects
				const adaptedContext = {
					messages: context.messages.map((m) => ({
						role: m.role,
						content: m.content,
						toolCallId: (m as Record<string, unknown>).toolCallId as string | undefined,
						toolName: (m as Record<string, unknown>).toolName as string | undefined,
					})),
					systemPrompt: context.systemPrompt,
				};

				const realStream = createQwenStream(
					model.id,
					baseUrl,
					model.headers,
					adaptedContext,
					cred.access,
					{
						temperature: options?.temperature,
						maxTokens: options?.maxTokens,
						reasoning: options?.reasoning,
						signal: options?.signal,
					},
				);

				// Pipe real stream events to wrapper
				(async () => {
					try {
						for await (const event of realStream) {
							wrapper.push(event);
						}
						wrapper.end(await realStream.result());
					} catch (error) {
						wrapper.push({
							type: "error",
							reason: "error",
							error: {
								role: "assistant",
								content: [],
								api: "openai-completions",
								provider: "qwen-oauth",
								model: model.id,
								usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
								stopReason: "error",
								errorMessage: error instanceof Error ? error.message : String(error),
								timestamp: Date.now(),
							},
						});
						wrapper.end({
							role: "assistant",
							content: [],
							api: "openai-completions",
							provider: "qwen-oauth",
							model: model.id,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
							stopReason: "error",
							errorMessage: error instanceof Error ? error.message : String(error),
							timestamp: Date.now(),
						});
					}
				})();
			}).catch((error) => {
				wrapper.push({
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						content: [],
						api: "openai-completions",
						provider: "qwen-oauth",
						model: model.id,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						stopReason: "error",
						errorMessage: error instanceof Error ? error.message : String(error),
						timestamp: Date.now(),
					},
				});
				wrapper.end({
					role: "assistant",
					content: [],
					api: "openai-completions",
					provider: "qwen-oauth",
					model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				});
			});

			return wrapper;
		},
		oauth: {
			name: "Qwen OAuth",
			login: async (callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> => {
				// Login to the currently active profile
				const currentStore = loadProfileStore();
				const active = getActiveProfile(currentStore);
				if (!active) {
					throw new Error("No active Qwen OAuth profile. Run /qwen-profile to set one up.");
				}
				return loginProfile(currentStore, active.key, callbacks);
			},
			refreshToken: async (credentials: OAuthCredentials): Promise<OAuthCredentials> => {
				// Find which profile matches this credential's refresh token
				const currentStore = loadProfileStore();
				for (const profile of currentStore.profiles) {
					const cred = getCredential(currentStore, profile.key);
					if (cred?.refresh === credentials.refresh) {
						const refreshed = await refreshProfileCredential(currentStore, profile.key);
						return {
							refresh: refreshed.refresh,
							access: refreshed.access,
							expires: refreshed.expires,
							enterpriseUrl: refreshed.enterpriseUrl,
						};
					}
				}
				// Fallback: refresh via the passed credentials (won't update our store)
				return refreshQwenToken(credentials);
			},
			getApiKey: (credentials) => credentials.access,
			modifyModels: (models, credentials) => {
				const baseUrl = normalizeBaseUrl(credentials.enterpriseUrl as string | undefined);
				return models.map((model) => (model.provider === "qwen-oauth" ? { ...model, baseUrl } : model));
			},
		},
	});
}
