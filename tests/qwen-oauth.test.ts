import test from "node:test";
import assert from "node:assert/strict";

import registerQwenOAuthProvider, { refreshQwenToken, loginQwen } from "../index.ts";
import type { OAuthCredentials } from "@mariozechner/pi-ai";

type ProviderRegistration = {
	name: string;
	config: {
		baseUrl: string;
		models: Array<{ id: string; compat?: { thinkingFormat?: string } }>;
		headers?: Record<string, string>;
		oauth?: {
			modifyModels?: (models: Array<{ provider: string; baseUrl?: string }>, credentials: { enterpriseUrl?: string }) => Array<{ provider: string; baseUrl?: string }>;
		};
	};
};

type BeforeProviderRequestHandler = (event: { payload: unknown }) => unknown;

function registerExtension(): { registration: ProviderRegistration; beforeProviderRequest?: BeforeProviderRequestHandler } {
	let registration: ProviderRegistration | undefined;
	let beforeProviderRequest: BeforeProviderRequestHandler | undefined;

	registerQwenOAuthProvider({
		registerProvider(name: string, config: ProviderRegistration["config"]) {
			registration = { name, config };
		},
		on(event: string, handler: BeforeProviderRequestHandler) {
			if (event === "before_provider_request") {
				beforeProviderRequest = handler;
			}
		},
	} as never);

	if (!registration) {
		throw new Error("Provider registration was not captured");
	}

	return { registration, beforeProviderRequest };
}

test("registers Qwen OAuth against the Qwen portal endpoint by default", () => {
	const { registration } = registerExtension();

	assert.equal(registration.name, "qwen-oauth");
	assert.equal(registration.config.baseUrl, "https://portal.qwen.ai/v1");
});

test("registers only the coder-model", () => {
	const { registration } = registerExtension();

	assert.deepEqual(
		registration.config.models.map((model) => model.id),
		["coder-model"],
	);
});

test("maps OAuth resource_url from portal hosts to /v1 instead of /compatible-mode/v1", () => {
	const { registration } = registerExtension();
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
	const { registration } = registerExtension();
	const modifyModels = registration.config.oauth?.modifyModels;

	if (!modifyModels) {
		throw new Error("Expected oauth.modifyModels to be registered");
	}

	const [model] = modifyModels(
		[{ provider: "qwen-oauth", baseUrl: "https://placeholder.invalid" }],
		{ enterpriseUrl: "dashscope.aliyuncs.com" },
	);

	assert.equal(model?.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
});

test("adds the Qwen Portal headers required for OAuth chat completions", () => {
	const { registration } = registerExtension();

	assert.deepEqual(registration.config.headers, {
		"X-DashScope-AuthType": "qwen-oauth",
		"X-DashScope-UserAgent": "QwenCode/0.14.0 (darwin; arm64)",
		"User-Agent": "QwenCode/0.14.0 (darwin; arm64)",
	});
});

test("normalizes coder-model payloads to include a system message with content parts", () => {
	const { beforeProviderRequest } = registerExtension();
	if (!beforeProviderRequest) {
		throw new Error("Expected before_provider_request handler to be registered");
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
		throw new Error("Expected before_provider_request handler to be registered");
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
		throw new Error("Expected before_provider_request handler to be registered");
	}

	const payload = {
		model: "gpt-4.1",
		messages: [{ role: "user", content: "hi" }],
	};

	assert.deepEqual(beforeProviderRequest({ payload }), payload);
});

test("uses thinkingFormat qwen to map effort to enable_thinking boolean", () => {
	const { registration } = registerExtension();

	for (const model of registration.config.models) {
		assert.equal(model.compat?.thinkingFormat, "qwen", `model ${model.id} should use thinkingFormat "qwen"`);
	}
});

// ---------------------------------------------------------------------------
// Token refresh tests
// ---------------------------------------------------------------------------

const QWEN_TOKEN_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/token";

const mockFetch = (response: { ok: boolean; status?: number; json: () => Promise<unknown>; text?: () => Promise<string> }) => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
		// Assert the request targets the correct endpoint
		assert.equal(url.toString(), QWEN_TOKEN_ENDPOINT);
		assert.equal((init as RequestInit).method, "POST");

		// Assert the request body contains refresh_token grant
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
	// expires should be ~3600s from now, minus 5min buffer (3300s)
	const delta = result.expires - Date.now();
	assert.ok(delta > 3290 * 1000 && delta < 3301 * 1000, `expiry delta ${delta}ms should be ~3300000ms`);
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
			assert.ok((err as Error).message.includes("did not include an access token"));
			return true;
		},
	);

	restore();
});

// ---------------------------------------------------------------------------
// Login flow tests
// ---------------------------------------------------------------------------

const QWEN_DEVICE_CODE_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/device/code";

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
			const response = tokenResponses[callIndex++] || tokenResponses[tokenResponses.length - 1];
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

	assert.ok(capturedSignal === controller.signal, "signal should be passed to device code fetch");
});

test("loginQwen calls onProgress during long poll", async () => {
	const progressMessages: string[] = [];

	// Speed up polls by making setTimeout resolve instantly
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
			// 9x authorization_pending (no progress)
			...Array(9).fill({
				ok: false,
				json: async () => ({ error: "authorization_pending" }),
			}),
			// 10th poll triggers onProgress
			{
				ok: false,
				json: async () => ({ error: "authorization_pending" }),
			},
			// Success on 11th
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
