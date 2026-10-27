# occ

A minimal, headless CLI coding agent. No TUI, no web UI, no desktop — just
`occ` on the command line.

```
$ occ "explain this codebase"
> build · big-pickle
This codebase is a TypeScript monorepo that bundles a coding agent...
```

## Why

- **Scriptable** — drop into CI, git hooks, or shell pipelines.
- **One binary** — single executable, no extra processes.
- **No UI lock-in** — `occ` exits when the agent is idle, perfect for cron jobs
  and automation.
- **Multi-key rotation** — load multiple API keys per provider; the CLI
  rotates them on every request and skips keys that hit rate limits.

## Install

Windows — PowerShell 5.1+ already ships with Windows 10/11, so there is nothing
else to install. This downloads the latest release into `~\.occ\bin`, adds it to
`PATH`, and upgrades in place if `occ` is already there:

```powershell
irm https://raw.githubusercontent.com/qubexs/occ/main/install.ps1 | iex
```

Pin a version by setting `$env:VERSION` first:

```powershell
$env:VERSION = "0.2.1"; irm https://raw.githubusercontent.com/qubexs/occ/main/install.ps1 | iex
```

Linux / macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/qubexs/occ/main/install | bash
```

Both installers drop the binary in `~/.occ/bin` and update your `PATH`; re-running
them upgrades in place.

### From source

Only needed for development — skip this if the installer above worked. The only
requirement is [Bun](https://bun.sh) 1.3+:

```bash
git clone https://github.com/qubexs/occ.git
cd occ
bun install
bun run build
# binary at: packages/occ/dist_new8/occ-<os>-<arch>/bin/occ
occ --version
```

`occ` is a single self-contained executable: no Node, Bun, or shared libraries
are required at runtime.

## Usage

`run` is the default subcommand, so `occ "..."` is equivalent to `occ run "..."`.

```bash
occ --help                              # list subcommands
occ "Explain this codebase"             # one-shot prompt (uses config model)
occ run -m opencode/big-pickle "..."    # explicit model
occ run -m anthropic/claude-sonnet-4 "..."  # paid provider
occ run -f src/foo.ts "Review this"     # attach file context
occ run --format json "..."             # stream raw events as JSON
occ session list                        # browse past sessions
occ session show <id>                   # inspect a session
occ stats --days 7                      # token usage
occ mcp list                            # list MCP servers
occ providers list                      # list configured credentials
occ auth login                          # interactive provider login
occ models                              # list all available models
occ upgrade                             # self-update
occ uninstall                           # remove
```

The `mini` subcommand starts a small interactive chat box (the only interactive
mode kept from the upstream TUI). Useful for live testing without leaving the
terminal:

```bash
occ mini
```

## Multi-key rotation

`occ` rotates API keys transparently. Configure an array of keys per
provider and the CLI round-robins them, skips keys that are in cooldown,
and locks out keys that the provider rejects.

```jsonc
// occ.jsonc
{
  "model": "opencode/big-pickle",
  "provider": {
    "opencode": {
      "options": {
        "apiKey": [
          "sk-oc-account-1",
          "sk-oc-account-2",
          "sk-oc-account-3"
        ]
      }
    }
  }
}
```

On startup you'll see how many keys are loaded:

```
occ config:
  global:  none
  project: ./occ.jsonc
  keys:    opencode=3 (sk-oc-ac…ount-1, sk-oc-ac…ount-2, sk-oc-ac…ount-3)
```

### How rotation works

| Event | Action |
|---|---|
| Each request | Pick the next ready key (round-robin), skipping keys whose last response already reported an empty quota window. |
| `429 Too Many Requests` | Cool the key down (`retry-after`, 30s base, ramps to 120s) and **retry the same request immediately on the next key** — it does not wait out the window. |
| `401` / `402` / `403` | Park the key for 24 hours, then let it back in — a transient rejection does not remove it for the life of the process. |
| `200 OK` | Reset the key's failure counter and record the quota headers. |

Quota is tracked per key, never per chat: a 429 on one key cannot make the next
key look half-empty, and the numbers in the logs always belong to the credential
that produced them.

The SDK is constructed once and cached; the rotated key is injected per
request via the `Authorization` header, so there's no per-key SDK overhead.

### Why this works for the free tier

opencode-zen's free models are rate-limited per API key:

| Model | Req / min | Req / day |
|---|---|---|
| `big-pickle` | 12 | 250 |
| `mimo-v2.5-free` | 8 | 200 |
| `ling-3.0-flash-fin-free` | 5 | 100 |
| `muse-spark-1.2-contributor-free` | 5 | 100 |
| `nemotron-3-ultra-free` | 3 | 60 |
| `nemotron-3.5-lightning-free` | 3 | 60 |

The counter is keyed on the key itself, not on the IP, browser, or
machine. Three free accounts configured as three keys give you `3 × 250 =
750` requests per day against `big-pickle` with no other changes.

> **Heads up.** This is a workaround against per-key token buckets. Respect
> the provider's terms of service. If you need sustained high volume, the
> supported path is to add a paid provider key (Anthropic, OpenAI, etc.)
> or self-host an OpenAI-compatible endpoint like Ollama.

## Configuration

Drop a config at any of these locations:

| Scope | Path |
|---|---|
| Project | `./occ.json` |
| Project | `./occ.jsonc` |
| Project | `./opencode.json` / `./opencode.jsonc` (also read) |
| Project | `./.opencode/config.json` (also read) |
| Global  | `~/.config/occ/config.json` |
| Global  | `~/.config/opencode/config.json` (also read) |

`occ.*` files take precedence; `opencode.*` is also honored for compatibility.

### Environment variables

| Variable                  | Purpose                            |
| ------------------------- | ---------------------------------- |
| `OCC_PRINT_LOGS`          | Print logs to stderr               |
| `OCC_LOG_LEVEL`           | `DEBUG` / `INFO` / `WARN` / `ERROR`|
| `OCC_PURE`                | Disable terminal colors            |
| `OCC_CONFIG`              | Path to config file                |
| `OCC_CONFIG_DIR`          | Path to config directory           |
| `OCC_CONFIG_CONTENT`      | Inline JSON config (bypasses file) |
| `OCC_PERMISSION`          | Permission preset                  |
| `OCC_SERVER_PASSWORD`     | Server auth                        |
| `OCC_BIN_PATH`            | Override path to `occ` binary      |
| (new)                     | `OCC_BIN_PATH`           |

`OPENCODE_*` is still honored for backwards compatibility.

### Data directories

| Purpose      | Path                              |
| ------------ | --------------------------------- |
| Install dir  | `~/.occ/bin/occ`                  |
| User data    | `~/.local/share/occ/`             |
| User state   | `~/.local/state/occ/`             |
| User config  | `~/.config/occ/`                  |
| User cache   | `~/.cache/occ/`                   |
| Project dir  | `./.occ/` (or `./.opencode/`)     |

## Subcommands

Kept (CLI only):

```
run           # default — one-shot prompt
mini          # small interactive chat box
auth          # manage credentials
agent         # manage agents
mcp           # manage MCP servers
session       # list / inspect / share sessions
stats         # token usage
export        # export session to markdown
import        # import shared session
pr            # PR helpers
db            # database inspection
serve         # headless HTTP server (for `mini --attach`)
providers     # list / login / logout
models        # list all available models
generate      # run a generator
plug          # plugin management
debug         # debug utilities
upgrade       # self-update
uninstall     # remove
github        # GitHub bot commands
```

Removed (TUI / web / desktop only):

```
tui, web, attach, acp, console (browser console)
```

## Development

```bash
bun install

# typecheck
bun --cwd packages/occ run typecheck

# build a single binary (no TUI/web assets)
bun --cwd packages/occ script/build.ts --single --skip-embed-web-ui
# output: packages/occ/dist_new8/occ-<os>-<arch>/bin/occ

# run a source build (with hot reload, TUI+web conditions)
bun --cwd packages/occ run dev
```

### Project layout

```
packages/
  occ/                    # main CLI package
    src/
      cli/cmd/            # yargs subcommands
      session/llm/        # LLM runtime adapters
        key-pool.ts       # multi-key rotation
        ai-sdk.ts         # AI SDK bridge
        native-runtime.ts # @opencode-ai/llm bridge
        native-request.ts # session → LLM request lowering
      provider/provider.ts# provider plugins (incl. multi-key)
    bin/occ               # Node shim launcher
    script/build.ts       # bun → single-binary compiler
  core/                   # cross-cutting Effect services
  llm/                    # @opencode-ai/llm — route + protocol layer
  tui/                    # TUI source (used by `occ mini`)
  ...
```

### Building a new release

```bash
git tag v0.1.0
git push origin v0.1.0
# CI builds for linux-x64, darwin-arm64, darwin-x64, windows-x64
# and uploads to the release page
```

## Scope

`occ` is a CLI-only build. The following are not built or shipped:

- TUI subcommand (kept only the `--mini` interactive mode)
- Web UI
- Browser console
- Desktop / Electron app
- Web UI asset embedding
- TUI binary embedding
- Docker / AUR / Homebrew / Snap package templates
- VS Code extension

## Features

- **Multi-key rotation** — load multiple API keys per provider; the CLI
  rotates them on every request, skips keys in cooldown, fails over
  mid-request instead of waiting out a 429, and parks keys the provider
  rejects
- Per-provider key pool with cooldown + invalid-key tracking
- Masked key fingerprints in the startup banner
- `occ mini` subcommand for an inline chat box
- `OCC_BIN_PATH` env var (path override for the `occ` binary)

## License

MIT.
