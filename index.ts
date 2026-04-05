/**
 * Qwen OAuth provider for pi.
 *
 * Registers Qwen OAuth device login and the current Qwen OAuth model aliases
 * exposed through the Qwen Portal OpenAI-compatible chat completions API.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const QWEN_DEVICE_CODE_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/device/code";
const QWEN_TOKEN_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/token";
const QWEN_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
const QWEN_SCOPE = "openid profile email model.completion";
const QWEN_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const QWEN_DEFAULT_BASE_URL = "https://portal.qwen.ai/v1";
const QWEN_DEFAULT_POLL_INTERVAL_MS = 2000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const QWEN_PORTAL_USER_AGENT = "QwenCode/0.13.2 (darwin; arm64)";

/**
 * Qwen Code maps effort levels to thinking_budget (max tokens for internal reasoning).
 * These values match Qwen Code's official defaults for models with >= 128K context.
 * See: QwenLM/qwen-code packages/core/src/core/openaiContentGenerator/pipeline.ts
 */
const QWEN_THINKING_BUDGET: Record<string, number> = {
	minimal: 1_000,
	low: 8_000,
	medium: 32_000,
	high: 64_000,
	xhigh: 128_000,
};

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

interface QwenModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
}

interface QwenPortalMessage {
	role?: unknown;
	content?: unknown;
	[key: string]: unknown;
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
	{
		id: "vision-model",
		name: "Qwen Vision",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 32768,
	},
];

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

function normalizeQwenPortalPayload(payload: unknown): unknown {
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

	// Convert pi-ai's reasoning.effort (sent via thinkingFormat: "openrouter")
	// to the Qwen OAuth API's thinking_budget + enable_thinking.
	// Qwen Code officially sends { reasoning: { effort: "medium" } } for its
	// OpenAI-compatible endpoint; the Qwen Portal API expects numeric thinking_budget.
	const result: Record<string, unknown> = { ...payload, messages };
	const reasoning = result.reasoning;
	if (isRecord(reasoning) && typeof reasoning.effort === "string") {
		const budget = QWEN_THINKING_BUDGET[reasoning.effort];
		if (budget !== undefined) {
			result.enable_thinking = true;
			result.thinking_budget = budget;
		}
		delete result.reasoning;
	}

	return result;
}

function computeExpiry(expiresInSeconds: number): number {
	return Date.now() + expiresInSeconds * 1000 - FIVE_MINUTES_MS;
}

async function startDeviceFlow(): Promise<{ device: DeviceCodeResponse; verifier: string }> {
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
): Promise<TokenResponse> {
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(1000, Math.floor((intervalSeconds ?? QWEN_DEFAULT_POLL_INTERVAL_MS / 1000) * 1000));

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Qwen login cancelled");
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

async function loginQwen(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { device, verifier } = await startDeviceFlow();
	const authUrl = device.verification_uri_complete || device.verification_uri;
	const instructions = device.verification_uri_complete ? undefined : `Enter code: ${device.user_code}`;

	callbacks.onAuth({ url: authUrl, instructions });

	const token = await pollForToken(device.device_code, verifier, device.interval, device.expires_in, callbacks.signal);
	return {
		refresh: token.refresh_token || "",
		access: token.access_token,
		expires: computeExpiry(token.expires_in),
		enterpriseUrl: token.resource_url,
	};
}

async function refreshQwenToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
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

export default function registerQwenOAuthProvider(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => normalizeQwenPortalPayload(event.payload));

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
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
				...(model.reasoning ? { thinkingFormat: "openrouter" as const } : {}),
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
