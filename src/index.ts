// index.ts — opencode-windsurf-auth package entry point
//
// Dual-export contract (see MIGRATION_PLAN.md §1 for the loader trace):
//
//   1. Named export `createWindsurf` — picked up by the Provider SDK loader
//      (`provider/provider.ts` line 1740: scans `Object.keys(mod)` for the
//      first key starting with `"create"`).
//   2. Default export (V1 plugin format) — `{ id, server }` object picked
//      up by the plugin loader (`plugin/shared.ts:readV1Plugin` looks at
//      `mod.default` for an object with a `server` function). The V1 path
//      matches first, so the legacy fallback (`getLegacyPlugins`) never
//      iterates `Object.values(mod)` and never accidentally treats
//      `createWindsurf` as a plugin function.
//
//   These two consumers never conflict because they look at different
//   slots on the module namespace object.

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { WINDSURF_MODELS } from "./models"

// ── Provider SDK export ─────────────────────────────────────────────────
// Re-export from windsurf-provider.ts so the provider SDK loader finds it.
export { createWindsurf } from "./windsurf-provider.js"

// ── Plugin Hooks (V1 format) ───────────────────────────────────────────
async function WindsurfPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    provider: {
      id: "windsurf-devin-provider",
      async models(_provider, _ctx) {
        return WINDSURF_MODELS
      },
    },
    auth: {
      provider: "windsurf-devin-provider",
      methods: [
        {
          type: "api" as const,
          label: "Devin CLI (devin /login required once)",
        },
      ],
      loader: async () => ({}),
    },
  }
}

// V1 plugin format: default export is an object with `id` + `server`.
// The plugin loader detects this shape in `detect` mode and calls
// `default.server(input, options)`. The `id` field satisfies
// `resolvePluginId` (required for file:// plugins).
export default {
  id: "windsurf-auth",
  server: WindsurfPlugin,
}
