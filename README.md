# pi-extension-qwen-oauth-models

Qwen OAuth provider for [pi](https://github.com/badlogic/pi-mono) that logs in with your `qwen.ai` account and sends chat requests to the correct Qwen Portal API.

## Why this package exists

Qwen has multiple public API surfaces:

- **Qwen OAuth / qwen.ai account** → `https://portal.qwen.ai/v1`
- **Alibaba Cloud / DashScope API key** → `https://dashscope.aliyuncs.com/compatible-mode/v1`
- **Alibaba Cloud Coding Plan API key** → `https://coding.dashscope.aliyuncs.com/v1`

This package is specifically for the **free Qwen OAuth flow** exposed by `chat.qwen.ai` device login.

The common integration mistake is to authenticate with Qwen OAuth successfully, then keep sending model requests to DashScope-compatible paths such as `/compatible-mode/v1`. For Qwen Portal hosts, that yields `404` responses. This package fixes that by routing OAuth sessions to:

- `POST https://chat.qwen.ai/api/v1/oauth2/device/code`
- `POST https://chat.qwen.ai/api/v1/oauth2/token`
- `POST https://portal.qwen.ai/v1/chat/completions`

## Features

- Qwen OAuth device-code login with PKCE
- Automatic access-token refresh
- Correct `resource_url` normalization for Qwen Portal vs DashScope hosts
- Qwen Portal request normalization for OAuth-only header and system-message compatibility
- Current Qwen OAuth model aliases aligned with open-source Qwen Code integrations
- Packaged as a pi extension, ready for npm distribution

## Installation

### From npm

After publishing:

```bash
pi install npm:pi-extension-qwen-oauth-models
```

Or add it to `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "packages": [
    "npm:pi-extension-qwen-oauth-models"
  ]
}
```

### From a local checkout

```bash
pi install .
```

Or for one-off testing:

```bash
pi -e .
```

## Usage

1. Start `pi`
2. Run:

   ```text
   /login qwen-oauth
   ```

3. Complete the browser/device-code flow
4. Select a model, for example:

   ```text
   /model
   ```

Available models exposed by this package:

- `qwen-oauth/coder-model`
- `qwen-oauth/vision-model`

## Model mapping

This package intentionally exposes the **Qwen OAuth aliases**, not the larger Alibaba Cloud model catalog.

Current aliases used here:

| Alias | Purpose | Input |
| --- | --- | --- |
| `coder-model` | Coding/default Qwen OAuth model | text |
| `vision-model` | Vision-capable Qwen OAuth model | text, image |

These aliases track the current Qwen Code OAuth behavior instead of assuming every DashScope model is available to free OAuth accounts.

## Verification

Run the package checks:

```bash
npm run check
```

The check suite verifies:

- default base URL is `https://portal.qwen.ai/v1`
- `portal.qwen.ai` is normalized to `/v1`, not `/compatible-mode/v1`
- DashScope hosts still normalize to `/compatible-mode/v1`
- only the expected Qwen OAuth model aliases are registered

## References

Implementation is based on the current public docs and open-source integrations:

- Qwen Code authentication docs: `https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/`
- Alibaba Cloud OpenAI-compatible docs: `https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope`
- Qwen Code OAuth implementation: `https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/qwen/qwenOAuth2.ts`
- Qwen Code current OAuth model aliases: `https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/models/constants.ts`
- Qwen Code discussion of OAuth-backed models: `https://github.com/QwenLM/qwen-code/issues/702`
- Similar open-source OAuth integrations using Qwen Portal: `https://cdn.jsdelivr.net/npm/openclaw@2026.1.29/extensions/qwen-portal-auth/index.ts`

## Package notes

- pi loads TypeScript extensions directly, so there is no separate build artifact.
- Runtime dependencies on pi packages are declared as peer dependencies, per pi package guidance.
- `prepack` runs the test suite so `npm pack` and `npm publish` fail fast on regressions.
