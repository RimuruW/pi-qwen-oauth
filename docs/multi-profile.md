# Multi-Account Mode

> **Opt-in feature.** This mode is intended for users who need to keep multiple Qwen OAuth accounts available at the same time, especially across parallel pi sessions.

Manage multiple Qwen OAuth accounts (for example personal and work) as **separate providers** instead of a single provider with a global active profile. This avoids local cross-session state conflicts when one session logs in, refreshes, or logs out.

## Enable

Set the environment variable:

```bash
export PI_QWEN_OAUTH_PROFILES=true
```

When this variable is not set, the extension behaves like the normal single-account mode and only registers `qwen-oauth`.

## How It Works

- Account metadata is stored in `~/.pi/agent/qwen-oauth-profiles.json`
- OAuth credentials stay in pi's normal auth store (`~/.pi/agent/auth.json`), keyed by provider name
- Each account gets its own provider name:
  - `qwen-oauth`
  - `qwen-oauth-2`
  - `qwen-oauth-3`
- Each provider keeps its own token lifecycle and refresh path
- Parallel sessions can use different Qwen providers without sharing a global active account pointer

## Account Store

Accounts are stored in `~/.pi/agent/qwen-oauth-profiles.json`:

```json
{
  "version": 2,
  "accounts": [
    { "provider": "qwen-oauth", "label": "Default" },
    { "provider": "qwen-oauth-2", "label": "Work" },
    { "provider": "qwen-oauth-3", "label": "Personal" }
  ]
}
```

This file stores **labels and provider identities only**. Tokens are not stored here.

## Commands

```text
/qwen-profile                        # Open interactive account panel
/qwen-profile list                   # Show all accounts and their status
/qwen-profile add Work               # Add a new account (creates qwen-oauth-N)
/qwen-profile login qwen-oauth-2     # Show login instructions for a specific provider
/qwen-profile rename qwen-oauth-2 工作号
/qwen-profile remove qwen-oauth-2    # Remove the account and its saved auth entry
```

## Login Flow

After adding an account, run `/login` and select the matching OAuth entry shown by pi, for example:

```text
Qwen OAuth
Qwen OAuth — Work
Qwen OAuth — Personal
```

Then select the corresponding model directly:

```text
/model qwen-oauth/coder-model
/model qwen-oauth-2/coder-model
/model qwen-oauth-3/coder-model
```

## Migration from Legacy Profile Mode

If you previously used the old global-active-profile implementation, the first startup in multi-account mode automatically migrates:

- the legacy profile list to provider-based account metadata
- the legacy stored credentials to provider-specific auth entries

The previously active legacy profile becomes `qwen-oauth` so existing model selections remain as stable as possible.

## Limitations

- This only fixes **local provider/account isolation** inside pi
- If Qwen invalidates old tokens when the **same Qwen account** logs in elsewhere, that behavior still applies; the reliable workaround is using separate Qwen accounts
- Provider names are part of the trade-off: multiple accounts mean multiple model prefixes
- Removing an account deletes its saved auth entry for that provider
