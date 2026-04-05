# Repository Guidelines

## Project Structure & Module Organization

```
├── index.ts            # Main extension entry point — registers the Qwen OAuth provider
├── tests/
│   └── qwen-oauth.test.ts  # Provider tests
├── package.json        # Package metadata, scripts, and peer dependencies
└── README.md           # User-facing documentation
```

This is a **pi extension** (no build step). TypeScript is loaded directly via `node --experimental-strip-types`. The single entry point `index.ts` exports a default function that pi invokes to register the `qwen-oauth` provider.

## Build, Test, and Development Commands

| Command | Description |
|---|---|
| `npm run check` | Run tests via Node native test runner (`--experimental-strip-types --test`) |
| `npm run build` | No-op — pi loads `.ts` directly |
| `npm run prepack` | Runs `check` before publishing |

Node.js ≥ 20 is required. Peer dependencies: `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent`.

## Coding Style & Naming Conventions

- **Indentation**: Tabs (existing codebase convention).
- **Naming**: `PascalCase` for interfaces/types (`DeviceCodeResponse`, `QwenModelConfig`), `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for constants (`QWEN_DEVICE_CODE_ENDPOINT`).
- **No formatter/linter** is configured. Keep style consistent with existing code.
- **Imports**: `import type` for type-only imports. No default imports from peer packages except the extension API.

## Testing Guidelines

- **Framework**: Node.js native test runner (`node --test`).
- **File naming**: `*.test.ts` in `tests/`.
- **Run**: `npm run check`.
- Tests cover OAuth device flow, token polling, payload normalization, and provider registration. Add tests for new models, endpoint changes, or payload transformation logic.

## Commit & Pull Request Guidelines

- **Commit messages**: Use imperative, descriptive messages (e.g., `add vision model support`, `fix token refresh expiry calculation`). No enforced convention yet — keep messages clear and scoped.
- **Pull requests**: Include a description of the change, link related issues, and note any provider-facing behavior changes (new models, API endpoint updates, auth flow modifications).

## Security Notes

- Do **not** commit `QWEN_CLIENT_ID` changes without authorization — it is a registered OAuth application credential.
- `.env` and `.env.*` files are gitignored. Use environment variables only for local debugging.
- All OAuth tokens are handled at runtime via the pi credentials store; never log or persist them.
