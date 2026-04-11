# pi-qwen-oauth

[![npm version](https://img.shields.io/npm/v/pi-qwen-oauth.svg)](https://www.npmjs.com/package/pi-qwen-oauth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/RimuruW/pi-qwen-oauth/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/RimuruW/pi-qwen-oauth.svg)](https://github.com/RimuruW/pi-qwen-oauth)

Qwen OAuth provider for [pi](https://github.com/badlogic/pi-mono). Log in with your qwen.ai account and use Qwen models via the Qwen Portal OpenAI-compatible API.

> [Qwen](https://qwen.ai/research) is a powerful family of large language models developed by Alibaba Cloud's Tongyi Lab, excelling in reasoning, coding, and multilingual tasks. This project was built with the assistance of Qwen 3.6 Plus — most of the implementation and documentation were authored by the model itself.

## Features

- **OAuth Device Code login** with PKCE — authenticate via `chat.qwen.ai` without managing API keys
- **Automatic token refresh** — seamless session continuity
- **Correct endpoint routing** — OAuth sessions route to `https://portal.qwen.ai/v1`, DashScope hosts fall back to `/compatible-mode/v1`
- **Request normalization** — system messages formatted as Qwen Portal-compatible content parts
- **Thinking mode** — toggle thinking on/off via the TUI reasoning selector (Qwen Portal API supports `enable_thinking` as a boolean)

## Quick Start

### Install

```bash
# Via pi package manager
pi install npm:pi-qwen-oauth

# Or from source
git clone https://github.com/RimuruW/pi-qwen-oauth.git
cd pi-qwen-oauth
pi install .
```

### Use

```text
# Log in with Qwen OAuth
/login qwen-oauth

# Follow the browser/device-code flow in your browser

# Select a model
/model qwen-oauth/coder-model
```

## Models

| Alias                    | Input | Context | Max Tokens | Reasoning |
| ------------------------ | ----- | ------- | ---------- | --------- |
| `qwen-oauth/coder-model` | text  | 1M      | 65,536     | ✅        |

## Thinking Mode

The model has reasoning enabled. The pi TUI displays a thinking effort selector (off / minimal / low / medium / high). The Qwen Portal API only accepts `enable_thinking` as a boolean:

| TUI Selection                 | API Parameter            |
| ----------------------------- | ------------------------ |
| off                           | `enable_thinking: false` |
| minimal / low / medium / high | `enable_thinking: true`  |

Granular `thinking_budget` control is not supported by the Qwen Portal API — the model uses its own internal reasoning budget when thinking is enabled.

## Why This Exists

Qwen exposes multiple API surfaces with different authentication flows:

| Auth Method                       | Endpoint                                            |
| --------------------------------- | --------------------------------------------------- |
| Qwen OAuth (qwen.ai account)      | `https://portal.qwen.ai/v1`                         |
| Alibaba Cloud / DashScope API key | `https://dashscope.aliyuncs.com/compatible-mode/v1` |

A common mistake is authenticating with Qwen OAuth but sending requests to DashScope paths, which returns `404`. This extension handles the full OAuth device-code flow and routes requests to the correct endpoint.

## Project Structure

```
├── index.ts                  # Extension entry point — provider registration & OAuth flow
├── docs/
│   └── multi-profile.md      # Multi-account mode documentation (opt-in)
├── tests/
│   └── qwen-oauth.test.ts    # Provider & normalization tests
├── package.json
└── README.md
```

No build step — pi loads TypeScript extensions directly via `node --experimental-strip-types`.

## Development

```bash
npm run check    # Run tests
npm run prepack  # Run tests before publish
```

## Multi-Account Mode

Set `PI_QWEN_OAUTH_PROFILES=true` to manage multiple Qwen OAuth accounts. See [docs/multi-profile.md](docs/multi-profile.md) for details.

## References

- [Qwen Code auth docs](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)
- [Alibaba Cloud OpenAI-compatible API](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)
- [Qwen Code OAuth source](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/qwen/qwenOAuth2.ts)

## License

[MIT](https://github.com/RimuruW/pi-qwen-oauth/blob/main/LICENSE)
