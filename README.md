# zcode-auto-continue

ZCode plugin for automatic retry on transient errors — ported from `dsh-auto-continue`.

## Features

- **Hybrid architecture**: Real-time Stop hook + DB-polling watcher daemon
- **Error classification**: Automatically retries transient errors (network, timeout, 5xx, 429), skips permanent errors (auth, billing, context overflow)
- **Adaptive backoff**: Exponential backoff with configurable cap
- **Truncation recovery**: Detects and retries truncated responses
- **Empty response recovery**: Only when the transcript proves the last assistant turn had neither text nor tool calls (a turn that merely ended after tool calls is *not* treated as empty)
- **Loop guard**: Prevents infinite retry loops on identical errors
- **turn.failed coverage**: DB polling catches `turn.failed` (architectural blind spot of pure hook plugins)
- **Manual control**: `/auto-continue pause [10m] | resume | skip-once`; any real prompt resets the retry counters

## Architecture

| Component | Path | Role |
|-----------|------|------|
| Core logic | `lib/core.mjs` | Config resolution, error classification, backoff, template filling, transcript inspection |
| State management | `lib/state.mjs` | Shared state with lost-update merge between hook and watcher |
| Stats | `lib/stats.mjs` | Daily counters shared by both resume paths |
| Watcher daemon | `lib/watcher.mjs` | DB-polling fallback, catches turn.failed, deep backoff |
| Stop hook | `hooks/stop.mjs` | Real-time classification at turn end |
| SessionStart hook | `hooks/session-start.mjs` | Auto-launches watcher daemon |
| UserPromptSubmit hook | `hooks/user-prompt-submit.mjs` | Resets counters on real prompts; writes pause/suppress state |

## Installation

### Via ZCode Plugin Marketplace

1. Open ZCode → Settings → Plugins → Plugin Marketplace → Add Plugin Marketplace
2. Paste: `https://github.com/HbDenken/zcode-auto-continue`
3. Install `zcode-auto-continue`

### Manual

```bash
cp -r /path/to/zcode-auto-continue ~/.zcode/plugins/
```

## Usage

- `/auto-continue status` — Check daemon status and today's stats
- `/auto-continue stats` — View historical statistics
- `/auto-continue pause` — Temporarily disable
- `/auto-continue resume` — Re-enable

## Configuration

Copy `config.example.json` to `~/.zcode/auto-continue/config.json`:

```json
{
  "continueText": "继续",
  "cooldownMs": 20000,
  "maxConsecutive": 3,
  "backoffFactor": 2,
  "backoffMaxMs": 300000,
  "classify": true,
  "truncationGuard": true,
  "verbose": true
}
```

See `config.example.json` for all options.

## Testing

```bash
node test/self-check.mjs
```

## License

MIT
