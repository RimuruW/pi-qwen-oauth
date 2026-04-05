# Changelog

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
