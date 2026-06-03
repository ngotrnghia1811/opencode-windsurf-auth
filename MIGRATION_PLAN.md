# Windsurf Provider — Extraction Migration Plan

Goal: make `opencode-windsurf-auth/` a **fully self-contained** opencode plugin
(like `_references/opencode-anthropic-auth/`) that ships the working Level-2
Windsurf provider, so the upstream `opencode/` core needs **zero** windsurf
patches.

Status of inputs verified on 2026-06-02:
- Working impl currently lives in `opencode/packages/opencode/src/plugin/windsurf/`
  (committed at `5e8a85fc1d` on branch `dev`).
- All cross-file imports are external-safe — **no `@/...` core-internal imports**.
- Stale standalone files (`auth.ts`, `client.ts`, `transform.ts`, `constants.ts`,
  old README) are pre-breakthrough auth-only scaffold and will be REPLACED.

---

## 1. The loader contract (the one place a mistake breaks everything)

opencode resolves a custom provider SDK in `provider/provider.ts:resolveSDK`:

1. If `BUNDLED_PROVIDERS[model.api.npm]` exists → use it (this is the current
   in-core path, line 135). **We are removing this entry.**
2. Else: `Npm.add(model.api.npm)` (or a `file://` path) → dynamic `import()` →
   **call the first export whose name starts with `create`** (line 1740):
   ```ts
   const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
   const loaded = fn({ name: model.providerID, ...options })
   ```

Therefore the published package entry MUST export `createWindsurf` (a function
taking `{ name, ...options }` returning `{ languageModel(modelId) }`). It already
has this signature (`windsurf-provider.ts:626`).

Two independent consumers import the same package:
- **Provider SDK loader** → finds `createWindsurf` via the `create*` scan.
- **Plugin system** (`opencode.json` `"plugin": [...]`) → must find the
  `WindsurfPlugin` Hooks factory.

**KEY VERIFICATION (do this first, before bulk work):** confirm how opencode's
plugin loader selects the exported plugin from a package (default export? named?
all function exports invoked?). The Anthropic ref exports `WindsurfAuthPlugin`
as a named `Plugin`. Mirror exactly whatever the plugin loader expects so that
exporting BOTH `createWindsurf` and the plugin from one `index.ts` does not
confuse either consumer. If a clash exists, split entry points (e.g. provider
via `./dist/provider.js`, plugin via package default).

## 2. `api.npm` value

- **Local dev:** `file://<abs>/opencode-windsurf-auth/dist/index.js` (or the
  provider entry). The loader special-cases `file://` (skips `Npm.add`).
- **Published:** `"opencode-windsurf-auth"` (the package name).

`models.ts:43` currently hardcodes `npm: "windsurf-devin-provider"`. Change to a
single source constant so dev (`file://`) vs published (pkg name) is one switch.
Also update `providerID` references — the provider id (`windsurf-devin-provider`)
can STAY as the logical id; `api.npm` is the package locator and is what changes.

## 3. Files to move (8) — into `opencode-windsurf-auth/src/`

| From `opencode/.../plugin/windsurf/` | To `opencode-windsurf-auth/src/` | Notes |
|---|---|---|
| `windsurf-provider.ts` | `windsurf-provider.ts` | exports `createWindsurf` |
| `chat-client.ts` | `chat-client.ts` | — |
| `chat-request.ts` | `chat-request.ts` | fix research-doc path comments |
| `proto.ts` | `proto.ts` | — |
| `credentials.ts` | `credentials.ts` | — |
| `models.ts` | `models.ts` | flip `api.npm` source |
| `thinking-proxy.ts` | `thinking-proxy.ts` | spawns mitmproxy (runtime dep) |
| `index.ts` | merge into package entry | provides `WindsurfPlugin` Hooks |
| `__tests__/models.test.ts` | `src/__tests__/models.test.ts` | keep test |

DELETE stale: `src/auth.ts`, `src/client.ts`, `src/transform.ts`,
`src/constants.ts` (and their stale logic). Keep `acp-*.ts` OUT (unused, blocked).

## 4. Package wiring

`package.json` additions:
- `dependencies` (NOT just dev): `@ai-sdk/provider` (types used at type-level;
  safe as devDep IF erased — confirm no runtime value imports; currently
  type-only ⇒ devDependency is fine), `@opencode-ai/sdk` (for `Model` type —
  also type-only ⇒ devDep ok).
- Keep `@opencode-ai/plugin` peer + dev.
- Add `scripts/dev.ts` modeled on the Anthropic ref (build → symlink
  `dist/index.js` into `.opencode/plugins/windsurf-auth.js` → `tsc --watch`).
- `tsconfig.build.json` already correct (rootDir src, declaration, rewrite
  relative import extensions). Verify `.ts` import specifiers compile (impl uses
  extensionless `./thinking-proxy` etc — fine with bundler resolution; confirm
  `rewriteRelativeImportExtensions` tolerates extensionless).

## 5. Core reverts (back to vanilla opencode)

1. `provider/provider.ts:135-136` — remove the `"windsurf-devin-provider"`
   entry from `BUNDLED_PROVIDERS`.
2. `plugin/index.ts:23,84` — remove `import { WindsurfPlugin }` and its entry in
   the built-in plugin array.
3. Delete `opencode/packages/opencode/src/plugin/windsurf/` directory.
4. Commit on `dev`: `refactor(plugin): extract windsurf provider to standalone package`.

## 6. Verification

- In `opencode-windsurf-auth/`: `bun install`, `bun run build` (tsc clean),
  `bun test` (models test passes), `bun typecheck`.
- Local load: add `"plugin": ["file://.../dist/index.js"]` (or `bun run dev`
  symlink) to a test `opencode.json`; launch via `./opencode-local.sh` and
  confirm: (a) `windsurf-devin-provider` appears, (b) a model lists, (c) the
  `createWindsurf` SDK loads (a trivial non-credit check — model selectable;
  avoid burning Windsurf credits unless explicitly requested).
- Core: `bun typecheck` from `packages/opencode` after reverts (no dangling refs).

## 7. Open questions / risks

- **Plugin-vs-provider export selection** (§1) — the single real risk. Verify the
  plugin loader's export-selection rule before bulk moving.
- `@ai-sdk/provider` & `@opencode-ai/sdk` version skew vs what core resolves —
  pin to the versions core uses to avoid `LanguageModelV3` type drift.
- `thinking-proxy.ts` mitmproxy + `devin -p` are system prerequisites — document
  in README (not npm deps).

---

*Plan authored by @aki-main | 2026-06-02 | source impl commit `5e8a85fc1d`*
