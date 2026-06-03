// credentials.ts — load the Windsurf JWT from ~/.local/share/devin/credentials.toml
//
// The file format is simple TOML:
//   windsurf_api_key = "devin-session-token$eyJhbG..."
//
// We read the file, find the windsurf_api_key line, extract the value,
// and return the bare JWT (without the "devin-session-token$" prefix).
// Returns null if the file or key is absent.

import { homedir } from "node:os"
import { join } from "node:path"

const CREDS_PATH = join(homedir(), ".local/share/devin/credentials.toml")
const PREFIX = "devin-session-token$"

export async function loadWindsurfJwt(): Promise<string | null> {
  const file = Bun.file(CREDS_PATH)
  const exists = await file.exists()
  if (!exists) return null

  const text = await file.text()
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("windsurf_api_key")) continue

    const eq = trimmed.indexOf("=")
    if (eq === -1) continue

    let value = trimmed.slice(eq + 1).trim()
    // strip quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    // strip the devin-session-token$ prefix if present
    if (value.startsWith(PREFIX)) {
      return value.slice(PREFIX.length)
    }
    return value
  }

  return null
}
