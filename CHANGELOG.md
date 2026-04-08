# Changelog

## [0.2.0] — 2026-04-08

### Features
- add multi-profile OAuth account management (`/qwen-profile` command and TUI panel)

### Bug Fixes
- fix 400 error in multi-profile mode and improve TUI UX
- normalize messages in profiles-mode streamSimple
- handle expired token migration — show warning instead of misleading "Imported" notification
- fix `ctx.ui.confirm` missing message argument that rendered "undefined" in dialog

### Refactor
- improve auth.json sync and profile mode architecture

### Other
- remove vision-model from registered models

## [0.1.3] — 2026-04-06

### Features
- support AbortSignal cancellation in device login flow (immediate abort check, signal passed to device code fetch and token polling)
- report periodic progress via onProgress callback during long authorization polling (every 10 polls)
- export loginQwen for testability and consistency with other OAuth providers

### Tests
- add 3 new tests: immediate abort, signal propagation to device code fetch, onProgress invocation during long polls

## [0.1.2] — 2025-04-05

### Features
- Enable thinking mode support for `coder-model` and `vision-model` (`model.reasoning: true`, `thinkingFormat: "qwen"`)
- TUI reasoning effort selector now available for Qwen OAuth models
- Add MIT license

### Changes
- Rename package from `pi-extension-qwen-oauth-models` to `pi-qwen-oauth`
- Rewrite README as formal project documentation with badges, model table, and thinking mode explanation
- Add `author`, `license`, `repository`, `bugs`, `homepage` to package.json

### Tests
- Update test suite to verify thinkingFormat configuration
