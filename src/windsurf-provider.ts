import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  LanguageModelV3TextPart,
  LanguageModelV3ReasoningPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
  LanguageModelV3ToolResultOutput,
} from "@ai-sdk/provider"
import { launchProxyStream } from "./thinking-proxy"
import { loadWindsurfJwt } from "./credentials"
import { encodeGetChatMessageRequest, type GetChatMessageInput } from "./chat-request"
import { streamGetChatMessage, type ResponseEvent } from "./chat-client"

function getDevinPath(): string {
  const p = Bun.which("devin")
  if (!p) throw new Error("devin CLI not found — run `devin /login` first")
  return p
}

const ZERO_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
}

const STOP_REASON = { unified: "stop" as const, raw: "stop" }
const TOOL_CALLS_REASON = { unified: "tool-calls" as const, raw: "tool_use" }
const ERROR_REASON = { unified: "error" as const, raw: "error" }

const STREAM_TIMEOUT_MS = 300_000

const EMPTY_RESULT_ERROR = new Error(
  "Windsurf produced no content (empty stream — possible backend drop or timeout)",
)

function trackContent(tracker: { emitted: boolean }, type: string) {
  if (
    type === "text-delta" ||
    type === "text-start" ||
    type === "reasoning-delta" ||
    type === "reasoning-start" ||
    type === "tool-call" ||
    type === "tool-input-start"
  ) {
    tracker.emitted = true
  }
}

function stripDevinBanner(text: string): string {
  const noAnsi = text.replace(/\x1b\[[0-9;]*m/g, "")
  const bannerPatterns = [
    "Welcome to Devin CLI",
    "Logged in as",
    "You're all set",
    "✓ Organization",
  ]
  const lines = noAnsi.split("\n")
  let start = 0
  for (let i = 0; i < lines.length; i++) {
    if (bannerPatterns.some((p) => lines[i].includes(p))) {
      start = i + 1
      continue
    }
    break
  }
  return lines.slice(start).join("\n")
}

function flattenHistory(options: LanguageModelV3CallOptions): string {
  const tools = (options as { tools?: Record<string, { description?: string; parameters?: unknown }> }).tools
  const toolsPrompt = tools
    ? `<tools>\n${Object.entries(tools)
        .map(([name, def]) => `  ${name}: ${def.description ?? name}`)
        .join("\n")}\n</tools>\n\n`
    : ""

  const messages = options.prompt
    .map((msg) => {
      const role = msg.role
      const parts = typeof msg.content === "string" ? msg.content : msg.content
      if (typeof parts === "string") return `${role}: ${parts}`
      return `${role}: ${parts
        .map((p) => {
          if (p.type === "text") return (p as { type: "text"; text: string }).text
          if (p.type === "tool-result") {
            const tr = p as unknown as { toolCallId: string; toolName: string; output: unknown }
            return `[tool result #${tr.toolCallId}: ${JSON.stringify(tr.output)}]`
          }
          return ""
        })
        .join("")}`
    })
    .join("\n\n")

  return toolsPrompt + messages
}

// ── Level-2: direct Connect-RPC to Windsurf API ─────────────────────────────

function extractSystemPrompt(options: LanguageModelV3CallOptions): string {
  for (const msg of options.prompt) {
    if (msg.role === "system") return msg.content as string
  }
  return ""
}

/** Extract a plain string from a LanguageModelV3ToolResultOutput. */
function extractToolOutput(output: LanguageModelV3ToolResultOutput): string {
  const o = output as { type: string; value?: unknown; reason?: string }
  if (o.type === "text" && typeof o.value === "string") return o.value
  if (o.type === "json") return JSON.stringify(o.value)
  if (o.type === "error-text" && typeof o.value === "string") return o.value
  if (o.type === "error-json") return JSON.stringify(o.value)
  if (o.type === "execution-denied") return `Execution denied${o.reason ? `: ${o.reason}` : ""}`
  if (o.type === "content") return JSON.stringify(o.value)
  return JSON.stringify(output)
}

function convertToProtoMessages(
  options: LanguageModelV3CallOptions,
): GetChatMessageInput["messages"] {
  const result: GetChatMessageInput["messages"] = []
  for (const msg of options.prompt) {
    if (msg.role === "system") continue // handled separately as system_prompt f2

    if (msg.role === "user") {
      const content = typeof msg.content === "string"
        ? msg.content
        : (msg.content as LanguageModelV3TextPart[])
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("")
      result.push({ role: 1, content })
      continue
    }

    if (msg.role === "assistant") {
      const parts = msg.content as Array<
        LanguageModelV3TextPart | LanguageModelV3ReasoningPart | LanguageModelV3ToolCallPart
      >
      // Collect text/reasoning parts into a single text message
      const text = parts
        .filter((p) => p.type === "text" || p.type === "reasoning")
        .map((p) => (p as LanguageModelV3TextPart).text)
        .join("")
      // Emit tool-call parts as separate role=2 messages with f6
      const toolCalls = parts.filter(
        (p): p is LanguageModelV3ToolCallPart => p.type === "tool-call",
      )

      // If there's text, emit as standalone role=2 text message.
      // Prefer separate from tool-call messages when both are present.
      if (text) {
        result.push({ role: 2, content: text })
      }

      // Emit each tool-call as a pure role=2 tool-call message (no text attached)
      for (const tc of toolCalls) {
        const argumentsJson = typeof tc.input === "string"
          ? tc.input
          : JSON.stringify(tc.input)
        result.push({
          role: 2,
          toolCall: { id: tc.toolCallId, name: tc.toolName, argumentsJson },
        })
      }
      continue
    }

    if (msg.role === "tool") {
      const parts = msg.content as Array<LanguageModelV3ToolResultPart>
      for (const tr of parts) {
        if (tr.type !== "tool-result") continue
        result.push({
          role: 4,
          content: extractToolOutput(tr.output),
          toolResult: { toolCallId: tr.toolCallId },
        })
      }
      continue
    }
  }
  return result
}

function convertTools(options: LanguageModelV3CallOptions): GetChatMessageInput["tools"] {
  const tools = options.tools
  if (!tools) return []
  return tools
    .filter((t) => t.type === "function")
    .map((t) => {
      const ft = t as import("@ai-sdk/provider").LanguageModelV3FunctionTool
      return {
        name: ft.name,
        description: ft.description ?? ft.name,
        parametersJsonSchema: JSON.stringify(ft.inputSchema),
      }
    })
}

async function streamViaDirectConnect(
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
  options: LanguageModelV3CallOptions,
  modelId: string,
  tracker: { emitted: boolean },
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false

  const jwt = await loadWindsurfJwt()
  if (!jwt) return false

  const systemPrompt = extractSystemPrompt(options)
  const messages = convertToProtoMessages(options)
  const tools = convertTools(options)

  const body = encodeGetChatMessageRequest({
    jwt,
    systemPrompt,
    messages,
    tools,
    modelId,
  })

  let reasoningStarted = false
  let textStarted = false
  let finished = false

  const toolCalls = new Map<string, { name: string; argsChunks: string[] }>()
  let toolCallStarted = false

  const events = streamGetChatMessage(body, signal)

  function flushToolCall(id: string) {
    const tc = toolCalls.get(id)
    if (!tc) return
    toolCalls.delete(id)
    const input = tc.argsChunks.join("")
    controller.enqueue({ type: "tool-input-end", id })
    controller.enqueue({ type: "tool-call", toolCallId: id, toolName: tc.name, input })
    trackContent(tracker, "tool-call")
  }

  function flushAllToolCalls() {
    for (const id of toolCalls.keys()) {
      flushToolCall(id)
    }
    toolCallStarted = false
  }

  try {
    for await (const event of events) {
      if (finished) break

      switch (event.type) {
        case "reasoning": {
          if (!reasoningStarted) {
            controller.enqueue({ type: "reasoning-start", id: "0" })
            trackContent(tracker, "reasoning-start")
            reasoningStarted = true
          }
          controller.enqueue({ type: "reasoning-delta", id: "0", delta: event.delta })
          trackContent(tracker, "reasoning-delta")
          break
        }
        case "text": {
          if (reasoningStarted) {
            controller.enqueue({ type: "reasoning-end", id: "0" })
            reasoningStarted = false
          }
          if (!textStarted) {
            controller.enqueue({ type: "text-start", id: "1" })
            trackContent(tracker, "text-start")
            textStarted = true
          }
          controller.enqueue({ type: "text-delta", id: "1", delta: event.delta })
          trackContent(tracker, "text-delta")
          break
        }
        case "tool-call-start": {
          // close any prior text/reasoning stream
          if (reasoningStarted) {
            controller.enqueue({ type: "reasoning-end", id: "0" })
            reasoningStarted = false
          }
          if (textStarted) {
            controller.enqueue({ type: "text-end", id: "1" })
            textStarted = false
          }
          // flush any previous incomplete tool call
          flushAllToolCalls()
          // start new tool call
          toolCalls.set(event.id, { name: event.name, argsChunks: [] })
          controller.enqueue({ type: "tool-input-start", id: event.id, toolName: event.name })
          trackContent(tracker, "tool-input-start")
          toolCallStarted = true
          break
        }
        case "tool-call-delta": {
          const tc = toolCalls.get(event.id)
          if (tc) {
            tc.argsChunks.push(event.argsChunk)
          }
          controller.enqueue({ type: "tool-input-delta", id: event.id, delta: event.argsChunk })
          break
        }
        case "finish": {
          finished = true
          if (reasoningStarted) {
            controller.enqueue({ type: "reasoning-end", id: "0" })
            reasoningStarted = false
          }
          if (textStarted) {
            controller.enqueue({ type: "text-end", id: "1" })
            textStarted = false
          }
          // flush any pending tool calls
          flushAllToolCalls()

          const isToolUse = event.stopReason === 10
          const usage: LanguageModelV3Usage = {
            inputTokens: {
              total: event.inputTokens,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: event.outputTokens,
              text: event.outputTokens,
              reasoning: undefined,
            },
          }
          controller.enqueue({
            type: "finish",
            finishReason: isToolUse ? TOOL_CALLS_REASON : STOP_REASON,
            usage,
          })
          break
        }
      }
    }
  } catch {
    return false
  }

  if (!finished) {
    if (reasoningStarted) controller.enqueue({ type: "reasoning-end", id: "0" })
    if (textStarted) controller.enqueue({ type: "text-end", id: "1" })
    flushAllToolCalls()
    controller.enqueue({ type: "finish", finishReason: STOP_REASON, usage: ZERO_USAGE })
  }

  if (!tracker.emitted) {
    controller.enqueue({ type: "error", error: EMPTY_RESULT_ERROR })
  }
  controller.close()
  return true
}

// ── Fallback: devin -p path ──────────────────────────────────────────────────

async function fallbackDevinRun(
  modelId: string,
  prompt: string,
): Promise<{ output: string; exitCode: number; stderr: string }> {
  const proc = Bun.spawn(
    [getDevinPath(), "--permission-mode", "bypass", "--model", modelId, "-p", "--", prompt],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const output = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { output, exitCode, stderr }
}

async function doGenerateViaFallback(options: LanguageModelV3CallOptions, modelId: string): Promise<LanguageModelV3GenerateResult> {
  const prompt = flattenHistory(options)
  const { output, exitCode, stderr } = await fallbackDevinRun(modelId, prompt)

  if (exitCode !== 0) {
    throw new Error(`devin exited with code ${exitCode}: ${stderr.slice(0, 500)}`)
  }

  return {
    content: [{ type: "text", text: stripDevinBanner(output) }],
    finishReason: STOP_REASON,
    usage: ZERO_USAGE,
    warnings: [],
  }
}

// ── Proxy streaming path (best-effort reasoning enrichment) ─────────────────

async function streamViaProxy(
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
  events: AsyncGenerator<{ type: string; text: string } | { type: "finish"; model?: string; input_tokens?: number; output_tokens?: number; msg_id?: string }>,
  tracker: { emitted: boolean },
): Promise<boolean> {
  let reasoningStarted = false
  let textStarted = false
  let finished = false

  try {
    for await (const event of events) {
      if (finished) break

      switch (event.type) {
        case "reasoning": {
          const t = (event as { text: string }).text
          if (!reasoningStarted) {
            controller.enqueue({ type: "reasoning-start", id: "0" })
            trackContent(tracker, "reasoning-start")
            reasoningStarted = true
          }
          controller.enqueue({ type: "reasoning-delta", id: "0", delta: t })
          trackContent(tracker, "reasoning-delta")
          break
        }
        case "text": {
          const t = (event as { text: string }).text
          if (reasoningStarted) {
            controller.enqueue({ type: "reasoning-end", id: "0" })
            reasoningStarted = false
          }
          if (!textStarted) {
            controller.enqueue({ type: "text-start", id: "1" })
            trackContent(tracker, "text-start")
            textStarted = true
          }
          controller.enqueue({ type: "text-delta", id: "1", delta: t })
          trackContent(tracker, "text-delta")
          break
        }
        case "finish": {
          finished = true
          const f = event as { model?: string; input_tokens?: number; output_tokens?: number; msg_id?: string }

          if (reasoningStarted) {
            controller.enqueue({ type: "reasoning-end", id: "0" })
            reasoningStarted = false
          }
          if (textStarted) {
            controller.enqueue({ type: "text-end", id: "1" })
            textStarted = false
          }

          const usage: LanguageModelV3Usage = {
            inputTokens: {
              total: f.input_tokens,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: f.output_tokens,
              text: f.output_tokens,
              reasoning: undefined,
            },
          }
          controller.enqueue({ type: "finish", finishReason: STOP_REASON, usage })
          break
        }
      }
    }
  } catch {
    return false
  }

  // If we never got a finish event, emit one with zero usage
  if (!finished) {
    if (reasoningStarted) controller.enqueue({ type: "reasoning-end", id: "0" })
    if (textStarted) controller.enqueue({ type: "text-end", id: "1" })
    controller.enqueue({ type: "finish", finishReason: STOP_REASON, usage: ZERO_USAGE })
  }

  if (!tracker.emitted) {
    controller.enqueue({ type: "error", error: EMPTY_RESULT_ERROR })
  }
  controller.close()
  return true
}

// ── Fallback: direct devin -p word-split (no reasoning) ─────────────────────

async function streamViaFallback(
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
  modelId: string,
  text: string,
  tracker: { emitted: boolean },
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    controller.enqueue({ type: "error", error: EMPTY_RESULT_ERROR })
    controller.enqueue({ type: "finish", finishReason: ERROR_REASON, usage: ZERO_USAGE })
    controller.close()
    return
  }

  const proc = Bun.spawn(
    [getDevinPath(), "--permission-mode", "bypass", "--model", modelId, "-p", "--", text],
    {
      stdout: "pipe",
      stderr: "pipe",
      signal,
    },
  )

  const output = await new Response(proc.stdout).text()
  const stripped = stripDevinBanner(output)
  const wordPattern = /\S+\s*/g
  const words = stripped.match(wordPattern) ?? []

  controller.enqueue({ type: "text-start", id: "0" })
  trackContent(tracker, "text-start")
  for (const word of words) {
    controller.enqueue({ type: "text-delta", id: "0", delta: word })
    trackContent(tracker, "text-delta")
  }

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    controller.enqueue({ type: "error", error: new Error(`devin exit ${exitCode}: ${stderr.slice(0, 200)}`) })
    controller.enqueue({ type: "finish", finishReason: ERROR_REASON, usage: ZERO_USAGE })
    controller.close()
    return
  }
  controller.enqueue({ type: "text-end", id: "0" })
  controller.enqueue({ type: "finish", finishReason: STOP_REASON, usage: ZERO_USAGE })

  if (!tracker.emitted) {
    controller.enqueue({ type: "error", error: EMPTY_RESULT_ERROR })
  }
  controller.close()
}

// ── Model class ──────────────────────────────────────────────────────────────

export class WindsurfLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider: string
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  constructor(modelId: string) {
    this.provider = "windsurf"
    this.modelId = modelId
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    return doGenerateViaFallback(options, this.modelId)
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const text = flattenHistory(options)
    const modelId = this.modelId

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        const tracker = { emitted: false }

        // Combined abort signal: internal timeout + external signal from caller
        const timeoutAc = new AbortController()
        const timeoutId = setTimeout(
          () => timeoutAc.abort(new Error("Stream timeout")),
          STREAM_TIMEOUT_MS,
        )

        const externalSignal = options.abortSignal
        const onExternalAbort = () => {
          clearTimeout(timeoutId)
          timeoutAc.abort(externalSignal?.reason)
        }
        if (externalSignal) {
          if (externalSignal.aborted) {
            clearTimeout(timeoutId)
            timeoutAc.abort(externalSignal.reason)
          }
          externalSignal.addEventListener("abort", onExternalAbort, { once: true })
        }

        try {
          controller.enqueue({ type: "stream-start", warnings: [] })

          // Level-2: direct Connect-RPC to Windsurf API (with tools)
          const directSuccess = await streamViaDirectConnect(
            controller,
            options,
            modelId,
            tracker,
            timeoutAc.signal,
          )
          if (directSuccess) return

          // Try proxy path first (best-effort reasoning enrichment)
          const proxyStream = await launchProxyStream(modelId, text)
          if (proxyStream.ok) {
            const success = await streamViaProxy(controller, proxyStream.events, tracker)
            await proxyStream.cleanup()
            if (success) return
          }

          // Fallback: direct devin -p word-split (no reasoning)
          await streamViaFallback(controller, modelId, text, tracker, timeoutAc.signal)
        } finally {
          clearTimeout(timeoutId)
          if (externalSignal) {
            externalSignal.removeEventListener("abort", onExternalAbort)
          }
        }
      },
    })

    return { stream }
  }
}

export function createWindsurf(opts: { name: string }) {
  return {
    languageModel(modelId: string): LanguageModelV3 {
      return new WindsurfLanguageModel(modelId)
    },
  }
}

export * as WindsurfProvider from "."
