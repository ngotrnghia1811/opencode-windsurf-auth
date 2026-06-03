import { describe, expect, test } from "bun:test"
import { WINDSURF_MODELS } from "../models"

describe("WINDSURF_MODELS", () => {
  test("record is non-empty", () => {
    const entries = Object.entries(WINDSURF_MODELS)
    expect(entries.length).toBeGreaterThan(0)
  })

  test("every model has id starting with windsurf/", () => {
    for (const model of Object.values(WINDSURF_MODELS)) {
      expect(model.id.startsWith("windsurf/")).toBe(true)
    }
  })

  test("every model has api.npm containing windsurf-auth", () => {
    for (const [_, model] of Object.entries(WINDSURF_MODELS)) {
      expect(model.api.npm).toBeString()
      expect(model.api.npm.includes("windsurf-auth")).toBe(true)
    }
  })

  test("every model has a non-empty api.id", () => {
    for (const model of Object.values(WINDSURF_MODELS)) {
      expect(model.api.id.length).toBeGreaterThan(0)
    }
  })

  test("summary", () => {
    const entries = Object.entries(WINDSURF_MODELS)
    const counts: Record<string, number> = {}
    for (const [, model] of entries) {
      const prefix = model.id.split("/")[1]?.split("-")[0] ?? "unknown"
      counts[prefix] = (counts[prefix] ?? 0) + 1
    }

    console.log(`\nTotal models: ${entries.length}`)
    console.log("By id prefix:")
    for (const [prefix, count] of Object.entries(counts).sort(([, a], [, b]) => b - a)) {
      console.log(`  ${prefix}: ${count}`)
    }

    expect(entries.length).toBeGreaterThan(100)
  })
})
