import { spawn } from "bun"
import { resolve } from "node:path"

// ── Constants ──────────────────────────────────────────────────────────────

const RESEARCH_DIR = "/Users/nghiango-mbp/opencode-learn/opencode-windsurf-auth/research"
const THINKING_PROXY_PY = resolve(RESEARCH_DIR, "thinking_proxy.py")
const MITMPROXY_CA = resolve(process.env.HOME ?? "/tmp", ".mitmproxy/mitmproxy-ca-cert.pem")
const PROXY_STREAM_TIMEOUT_MS = 180_000

type ProxyEvent =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "finish"; model?: string; input_tokens?: number; output_tokens?: number; msg_id?: string }

type StreamResult =
  | { ok: true; events: AsyncGenerator<ProxyEvent>; cleanup: () => Promise<void> }
  | { ok: false }

// ── Main entry: launch proxy + devin, return an event generator ────────────

export async function launchProxyStream(
  modelId: string,
  prompt: string,
): Promise<StreamResult> {
  const mitmdump = Bun.which("mitmdump")
  if (!mitmdump) return { ok: false }

  const devinPath = Bun.which("devin")
  if (!devinPath) throw new Error("devin CLI not found — run `devin /login` first")

  const port = await findFreePort()
  const sinkPath = `/tmp/windsurf_thinking_${port}.jsonl`

  // Remove stale sink from previous run (if any)
  try {
    await Bun.file(sinkPath).delete()
  } catch {}

  // ── 1. Start mitmdump proxy ───────────────────────────────────────────
  const proxyProc = spawn({
    cmd: [mitmdump, "-q", "-p", String(port), "-s", THINKING_PROXY_PY],
    env: { ...Bun.env, WINDSURF_THINKING_SINK: sinkPath },
    stdout: "pipe",
    stderr: "pipe",
  })

  // Wait for proxy to be ready
  let proxyReady = false
  for (let i = 0; i < 50; i++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(200) })
      await resp.text()
      proxyReady = true
      break
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  if (!proxyReady) {
    proxyProc.kill()
    await proxyProc.exited.catch(() => {})
    try { await Bun.file(sinkPath).delete() } catch {}
    return { ok: false }
  }

  // ── 2. Spawn devin through the proxy ──────────────────────────────────
  const proxyUrl = `http://127.0.0.1:${port}`
  const devinProc = spawn({
    cmd: [devinPath, "--permission-mode", "bypass", "--model", modelId, "-p", "--", prompt],
    env: {
      ...Bun.env,
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      SSL_CERT_FILE: MITMPROXY_CA,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  // ── 3. Build generator + cleanup ─────────────────────────────────────
  const abort = new AbortController()

  const events = tailSink(sinkPath, abort.signal, devinProc, PROXY_STREAM_TIMEOUT_MS)

  const cleanup = async () => {
    abort.abort()
    devinProc.kill()
    proxyProc.kill()
    await devinProc.exited.catch(() => {})
    await proxyProc.exited.catch(() => {})
    try { await Bun.file(sinkPath).delete() } catch {}
  }

  return { ok: true, events, cleanup }
}

// ── Port allocation ────────────────────────────────────────────────────────

async function findFreePort(): Promise<number> {
  const server = Bun.listen({ port: 0, hostname: "127.0.0.1", socket: { data() {} } })
  const port = server.port
  server.stop()
  return port
}

// ── Tail a growing NDJSON file, yielding parsed events ────────────────────

async function* tailSink(
  path: string,
  signal: AbortSignal,
  devinProc?: { exited: Promise<number> },
  deadlineMs?: number,
): AsyncGenerator<ProxyEvent> {
  let offset = 0
  let devinExited = false
  const deadline = deadlineMs ? Date.now() + deadlineMs : undefined

  if (devinProc) {
    devinProc.exited
      .then(() => {
        devinExited = true
      })
      .catch(() => {
        devinExited = true
      })
  }

  while (!signal.aborted) {
    if (deadline && Date.now() >= deadline) return

    const file = Bun.file(path)
    const exists = await file.exists()
    if (!exists) {
      if (devinExited) return
      await delay(100, signal)
      continue
    }
    const text = await file.text()
    const chunk = text.slice(offset)
    if (chunk.length > 0) {
      offset = text.length
      for (const line of chunk.split("\n")) {
        if (!line) continue
        const event = parseJsonSafe<ProxyEvent>(line)
        if (!event) continue
        yield event
        if (event.type === "finish") return
      }
    }

    if (devinExited) return

    await delay(80, signal)
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve() }, { once: true })
  })
}

function parseJsonSafe<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
