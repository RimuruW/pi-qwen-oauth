import test from "node:test";
import assert from "node:assert/strict";

import registerQwenOAuthProvider from "../index.ts";

type ProviderRegistration = {
	name: string;
	config: {
		baseUrl: string;
		models: Array<{ id: string; compat?: { thinkingFormat?: string; supportsReasoningEffort?: boolean } }>;
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

test("registers only the Qwen OAuth aliases that current Qwen Code integrations expose", () => {
	const { registration } = registerExtension();

	assert.deepEqual(
		registration.config.models.map((model) => model.id),
		["coder-model", "vision-model"],
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
		"X-DashScope-UserAgent": "QwenCode/0.13.2 (darwin; arm64)",
		"User-Agent": "QwenCode/0.13.2 (darwin; arm64)",
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
			model: "vision-model",
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

test("converts reasoning.effort to thinking_budget + enable_thinking for Qwen models", () => {
	const { beforeProviderRequest } = registerExtension();
	if (!beforeProviderRequest) {
		throw new Error("Expected before_provider_request handler to be registered");
	}

	const normalized = beforeProviderRequest({
		payload: {
			model: "coder-model",
			messages: [{ role: "user", content: "hi" }],
			reasoning: { effort: "medium" },
		},
	}) as { thinking_budget?: number; enable_thinking?: boolean; reasoning?: unknown };

	assert.equal(normalized.thinking_budget, 32_000);
	assert.equal(normalized.enable_thinking, true);
	assert.equal(normalized.reasoning, undefined);
});

test("maps all effort levels to correct thinking_budget + enable_thinking values", () => {
	const { beforeProviderRequest } = registerExtension();
	if (!beforeProviderRequest) {
		throw new Error("Expected before_provider_request handler to be registered");
	}

	const effortToBudget: Record<string, number> = {
		minimal: 1_000,
		low: 8_000,
		medium: 32_000,
		high: 64_000,
		xhigh: 128_000,
	};

	for (const [effort, budget] of Object.entries(effortToBudget)) {
		const normalized = beforeProviderRequest({
			payload: {
				model: "coder-model",
				messages: [{ role: "user", content: "hi" }],
				reasoning: { effort },
			},
		}) as { thinking_budget?: number; enable_thinking?: boolean };

		assert.equal(normalized.thinking_budget, budget, `effort "${effort}" should map to thinking_budget ${budget}`);
		assert.equal(normalized.enable_thinking, true, `effort "${effort}" should set enable_thinking`);
	}
});

test("registers models with thinkingFormat openrouter and supportsReasoningEffort", () => {
	const { registration } = registerExtension();

	const coderModel = registration.config.models.find((m) => m.id === "coder-model");
	assert.ok(coderModel);
	assert.equal(coderModel.compat?.thinkingFormat, "openrouter");
	assert.equal(coderModel.compat?.supportsReasoningEffort, true);

	const visionModel = registration.config.models.find((m) => m.id === "vision-model");
	assert.ok(visionModel);
	assert.equal(visionModel.compat?.thinkingFormat, "openrouter");
	assert.equal(visionModel.compat?.supportsReasoningEffort, true);
});

test("ignores unknown effort values", () => {
	const { beforeProviderRequest } = registerExtension();
	if (!beforeProviderRequest) {
		throw new Error("Expected before_provider_request handler to be registered");
	}

	const normalized = beforeProviderRequest({
		payload: {
			model: "coder-model",
			messages: [{ role: "user", content: "hi" }],
			reasoning: { effort: "unknown_level" },
		},
	}) as { thinking_budget?: number };

	assert.equal(normalized.thinking_budget, undefined);
});

test("does not add thinking_budget when reasoning is absent", () => {
	const { beforeProviderRequest } = registerExtension();
	if (!beforeProviderRequest) {
		throw new Error("Expected before_provider_request handler to be registered");
	}

	const normalized = beforeProviderRequest({
		payload: {
			model: "coder-model",
			messages: [{ role: "user", content: "hi" }],
		},
	}) as { thinking_budget?: number };

	assert.equal(normalized.thinking_budget, undefined);
});
