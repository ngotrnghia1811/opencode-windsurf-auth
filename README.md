# opencode-windsurf-auth

OpenCode plugin providing a **Level-2 Connect-RPC provider** for Windsurf/Cascade
models (Claude, GPT, Gemini, Grok, DeepSeek, and more) via the **Devin CLI**
credentials flow.

> **Warning:** This plugin comes with no guarantees. You might be banned for
> breaking the Windsurf/Devin Terms of Service. Use at your own risk.

## What This Plugin Does

1. Reads the Windsurf JWT from `~/.local/share/devin/credentials.toml`
   (stored by the Devin CLI after `devin /login`).
2. Authenticates against Codeium's HTTP/2 Connect-RPC endpoint
   (`server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage`).
3. Provides a full `LanguageModelV3` implementation (`createWindsurf`) so
   opencode can use Windsurf models through its standard provider SDK.
4. Registers ~130+ models (Claude Opus/Sonnet/Haiku, GPT-5.x, Gemini 3.x,
   Grok, DeepSeek, Kimi, GLM, MiniMax, SWE, and Windsurf-native models).

## Prerequisites

- **[Devin CLI](https://devin.ai)** installed and authenticated:
  ```bash
  devin /login
  ```
- **[mitmproxy](https://mitmproxy.org/)** (specifically `mitmdump`) for
  the thinking-proxy fallback path. Install via pip/brew:
  ```bash
  pip install mitmproxy
  ```
- **[Bun](https://bun.sh)** >= 1.3.14
- **[OpenCode](https://github.com/anomalyco/opencode)** with plugin support

## Configuration

Add the plugin to your `opencode.json`:

```json
{
  "plugin": ["file:///path/to/opencode-windsurf-auth/dist/index.js"]
}
```

Or for npm (once published):

```json
{
  "plugin": ["opencode-windsurf-auth"]
}
```

## Provider Registration

The provider SDK uses the `providerID` `windsurf-devin-provider`. The model
entries in `models.ts` expose `api.npm` pointing to this package (via `file://`
for local dev, or the package name for published use).

The package exports both:
- **`createWindsurf`** (named) — consumed by the provider SDK loader's
  `create*` key scan.
- **default export (V1 plugin)** — `{ id: "windsurf-auth", server: WindsurfPlugin }`
  consumed by the plugin loader's `readV1Plugin` path.

These two consumers look at different slots on the module namespace and do
not conflict.

## Architecture

```
src/
├── index.ts              # Entry point: createWindsurf + V1 plugin default
├── windsurf-provider.ts  # LanguageModelV3 impl (doGenerate / doStream)
├── chat-client.ts        # HTTP/2 Connect-RPC streaming client
├── chat-request.ts       # Protobuf GetChatMessageRequest encoder
├── proto.ts              # Low-level varint/field/Connect-frame helpers
├── credentials.ts        # JWT loader from Devin CLI credentials.toml
├── models.ts             # ~130+ model definitions
└── thinking-proxy.ts     # mitmproxy-based fallback for reasoning/thinking
```

### Transport

- **Primary path**: Direct HTTP/2 to `server.codeium.com` via Bun's
  built-in ALPN-aware `fetch()`.
- **Fallback path** (thinking-aware): `thinking-proxy.ts` spawns
  `mitmdump` + `devin -p` and tails a JSONLines sink.

## Development

```bash
bun install
bun typecheck       # type-check the source
bun run build       # compile to dist/
bun test            # run unit tests
bun run dev         # build + symlink into .opencode/plugins/ + watch
```

The `bun run dev` script creates a symlink at
`.opencode/plugins/windsurf-auth.js` → `dist/index.js` so opencode can
load the plugin via `file://` while you iterate.

## License

MIT
