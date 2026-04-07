# Multi-Profile Mode

> **Not maintained as an official feature.** This feature is provided for developer and research reference only. It is not part of the stable public API, may change or be removed without notice, and is not designed for production or multi-user environments.

Manage multiple Qwen OAuth accounts (e.g., personal, work) with independent credentials through a single provider (`qwen-oauth`). The active profile determines which account's token is used for requests — model references (`qwen-oauth/coder-model`) remain unchanged regardless of the active profile.

## Enable

Set the environment variable:

```bash
export PI_QWEN_OAUTH_PROFILES=true
```

When this variable is not set, the extension behaves identically to the single-account mode described in the main README.

## How It Works

- Profile definitions and credentials are stored in `~/.pi/agent/qwen-oauth-profiles.json`
- Each profile has its own independent OAuth token
- The **active profile** determines which token is used for API requests
- Requests pick up the active profile's token at send time — switching profiles takes effect immediately

## Profile Store

Profiles are stored in `~/.pi/agent/qwen-oauth-profiles.json`:

```json
{
  "version": 1,
  "activeProfile": "default",
  "profiles": [
    { "key": "default", "label": "Default" },
    { "key": "work", "label": "Work" },
    { "key": "personal", "label": "Personal" }
  ],
  "credentials": {}
}
```

Credentials are automatically populated when you log in to each profile.

## Commands

```text
/qwen-profile              # Open interactive profile panel
/qwen-profile list         # Show all profiles and their status
/qwen-profile use work     # Switch active profile
/qwen-profile login work   # Login to a specific profile
/qwen-profile add backup   # Add a new profile
/qwen-profile rename work "工作号"  # Rename a profile's label
/qwen-profile remove work  # Remove a profile and its credentials
```

## Interactive Panel

Running `/qwen-profile` without arguments opens a TUI panel where you can:

- **Select** a profile to view details
- **Switch** the active profile
- **Login/Refresh** token for a profile
- **Rename** the display label
- **Remove** a profile (not `default`)

## Migration from Single-Account Mode

If you were previously logged in with `/login qwen-oauth` before enabling multi-profile mode, your existing credentials are automatically imported into the `default` profile on first startup. You don't need to re-login.

## `/login qwen-oauth` in Profiles Mode

When multi-profile mode is active, `/login qwen-oauth` logs in to the **currently active profile**. Use `/qwen-profile login <key>` to login to a specific profile directly.

## Status Bar

When profiles mode is active, the footer status bar shows the current profile:

```
Qwen: Default
Qwen: Work (not logged in)
```

## Limitations

- The active profile is **process-global** (shared across all pi sessions on the same machine).
- `/logout qwen-oauth` is not the recommended way to manage accounts in profiles mode. Use `/qwen-profile remove <key>` instead.
