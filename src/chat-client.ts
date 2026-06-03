// chat-client.ts — HTTP/2 Connect-RPC streaming client for Windsurf GetChatMessage
//
// Transport: Bun fetch with HTTPS (auto-negotiates HTTP/2 via ALPN).
// Bun's fetch supports streaming response bodies via response.body.getReader().
// This is the preferred approach over node:http2 because:
//   1. Bun fetch negotiates HTTP/2 automatically for HTTPS URLs
//   2. It provides a clean ReadableStream API for reading response bytes
//   3. No manual ALPN / TLS configuration needed
// Verified: earlier Python replay experiments used raw h2 connection and
// confirmed the server accepts HTTP/2 with Connect-RPC content-type.
//
// Response field map from:
//   opencode-windsurf-auth/research/connect_decode.py
//   GetChatMessageResponse: f3=delta_text, f9=delta_thinking, f5=stop_reason,
//     f10+f21=="anthropic"=signature frame, f7=stats sub-msg

import { parseConnectFrames, CONNECT_FLAG_EOS } from "./proto"

const ENDPOINT = "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage"

export type ResponseEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool-call-start"; id: string; name: string }
  | { type: "tool-call-delta"; id: string; argsChunk: string }
  | {
      type: "finish"
      model?: string
      inputTokens?: number
      outputTokens?: number
      msgId?: string
      stopReason?: number
    }

// ---------------------------------------------------------------------------
// Low-level protobuf field walking (mirrors connect_decode.py)
// ---------------------------------------------------------------------------

function parseVarint(buf: Uint8Array, offset: number): [number, number] {
  let result = 0
  let shift = 0
  while (true) {
    const byte = buf[offset]
    offset++
    result |= (byte & 0x7f) << shift
    if (!(byte & 0x80)) break
    shift += 7
  }
  return [result, offset]
}

interface ProtoField {
  field: number
  wire: number
  value: number | Uint8Array
}

function walkFields(body: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = []
  let i = 0
  while (i < body.byteLength) {
    const [tag, newI] = parseVarint(body, i)
    i = newI
    const field = tag >> 3
    const wire = tag & 7
    if (wire === 0) {
      const [v, ni] = parseVarint(body, i)
      i = ni
      fields.push({ field, wire, value: v })
    } else if (wire === 2) {
      const [ln, ni] = parseVarint(body, i)
      i = ni
      const val = body.slice(i, i + ln)
      i += ln
      fields.push({ field, wire, value: val })
    } else if (wire === 1) {
      i += 8
      fields.push({ field, wire, value: 0 })
    } else if (wire === 5) {
      i += 4
      fields.push({ field, wire, value: 0 })
    } else {
      break
    }
  }
  return fields
}

function fieldDict(body: Uint8Array): Map<number, number | Uint8Array> {
  const m = new Map<number, number | Uint8Array>()
  for (const f of walkFields(body)) {
    m.set(f.field, f.value)
  }
  return m
}

function extractString(body: Uint8Array, fieldNum: number): string | null {
  for (const f of walkFields(body)) {
    if (f.field !== fieldNum || f.wire !== 2) continue
    const val = f.value
    if (!(val instanceof Uint8Array)) continue
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(val)
    } catch {
      // try nested
      for (const sf of walkFields(val)) {
        if (sf.wire !== 2 || !(sf.value instanceof Uint8Array)) continue
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(sf.value)
        } catch {}
      }
    }
  }
  return null
}

function isSignatureFrame(body: Uint8Array): boolean {
  const fd = fieldDict(body)
  const f21 = fd.get(21)
  if (f21 instanceof Uint8Array) {
    try {
      if (new TextDecoder().decode(f21) === "anthropic") return true
    } catch {}
  }
  return false
}

function getStopReason(body: Uint8Array): number | null {
  const f5 = fieldDict(body).get(5)
  if (typeof f5 === "number") return f5
  return null
}

function extractToolCall(body: Uint8Array): { id?: string; name?: string; argsChunk?: string } | null {
  const f6 = fieldDict(body).get(6)
  if (!(f6 instanceof Uint8Array)) return null
  const sf = fieldDict(f6)
  const result: { id?: string; name?: string; argsChunk?: string } = {}
  const f1 = sf.get(1)
  if (f1 instanceof Uint8Array) {
    try { result.id = new TextDecoder().decode(f1) } catch {}
  }
  const f2 = sf.get(2)
  if (f2 instanceof Uint8Array) {
    try { result.name = new TextDecoder().decode(f2) } catch {}
  }
  const f3 = sf.get(3)
  if (f3 instanceof Uint8Array) {
    try { result.argsChunk = new TextDecoder().decode(f3) } catch {}
  }
  if (result.id || result.name || result.argsChunk) return result
  return null
}

function extractStats(body: Uint8Array) {
  const fd = fieldDict(body)
  const f7 = fd.get(7)
  if (!(f7 instanceof Uint8Array)) return null
  const sf = fieldDict(f7)

  const result: Record<string, string | number> = {}

  const modelBytes = sf.get(9)
  if (modelBytes instanceof Uint8Array) {
    try { result.model = new TextDecoder().decode(modelBytes) } catch {}
  }

  const inputF4 = sf.get(4)
  const inputF3 = sf.get(3)
  if (typeof inputF4 === "number") {
    result.inputTokens = inputF4
    if (typeof inputF3 === "number") result.cacheCreationInputTokens = inputF3
  } else if (typeof inputF3 === "number") {
    result.inputTokens = inputF3
  }

  const outputTokens = sf.get(5)
  if (typeof outputTokens === "number") result.outputTokens = outputTokens

  const msgIdBytes = sf.get(7)
  if (msgIdBytes instanceof Uint8Array) {
    try { result.msgId = new TextDecoder().decode(msgIdBytes) } catch {}
  }

  return Object.keys(result).length > 0 ? result : null
}

// ---------------------------------------------------------------------------
// Frame → event mapping
// ---------------------------------------------------------------------------

interface DecodeState {
  currentToolCallId: string | null
  model?: string
  inputTokens?: number
  outputTokens?: number
  msgId?: string
  emittedFinish: boolean
}

function freshDecodeState(): DecodeState {
  return { currentToolCallId: null, emittedFinish: false }
}

function mergeStats(state: DecodeState, stats: Record<string, string | number> | null): DecodeState {
  if (!stats) return state
  const result = { ...state }
  if (stats.model !== undefined) result.model = stats.model as string
  if (stats.inputTokens !== undefined) result.inputTokens = stats.inputTokens as number
  if (stats.outputTokens !== undefined) result.outputTokens = stats.outputTokens as number
  if (stats.msgId !== undefined) result.msgId = stats.msgId as string
  return result
}

function buildFinishEvent(state: DecodeState, stopReason?: number): ResponseEvent {
  return {
    type: "finish",
    model: state.model,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    msgId: state.msgId,
    stopReason,
  }
}

interface DecodeResult {
  event: ResponseEvent | null
  state: DecodeState
}

function decodeFrame(body: Uint8Array, state: DecodeState): DecodeResult {
  // signature frame: skip (redacted thinking → answer boundary)
  if (isSignatureFrame(body)) return { event: null, state }

  // tool call sub-message f6
  const toolCall = extractToolCall(body)
  if (toolCall) {
    // frame with f6.f1+f2 (id+name): start of a new tool call
    if (toolCall.id) {
      const newState: DecodeState = { ...state, currentToolCallId: toolCall.id }
      if (toolCall.name) {
        return { event: { type: "tool-call-start", id: toolCall.id, name: toolCall.name }, state: newState }
      }
      // id-only f6 frame: update tracking id, check for args chunk too
      if (toolCall.argsChunk) {
        return { event: { type: "tool-call-delta", id: toolCall.id, argsChunk: toolCall.argsChunk }, state: newState }
      }
      return { event: null, state: newState }
    }
    // frame with f6.f3 only (args delta): use the tracked current tool call id
    if (toolCall.argsChunk) {
      const id = state.currentToolCallId ?? "0"
      return { event: { type: "tool-call-delta", id, argsChunk: toolCall.argsChunk }, state }
    }
    return { event: null, state }
  }

  // stop frame: any stop_reason from f5 (4=end_turn, 10=tool_use)
  const stopReason = getStopReason(body)
  if (stopReason !== null) {
    // accumulate any stats in this frame too, then emit the single terminal finish
    const stats = extractStats(body)
    const finalState = mergeStats(mergeStats(state, stats), null)
    return {
      event: buildFinishEvent(finalState, stopReason),
      state: { ...finalState, emittedFinish: true },
    }
  }

  // text / reasoning / stats-only frames — accumulate stats silently, never emit finish
  let newState = state
  const stats = extractStats(body)
  if (stats) newState = mergeStats(newState, stats)

  const deltaThinking = extractString(body, 9)
  if (deltaThinking !== null) {
    return { event: { type: "reasoning", delta: deltaThinking }, state: newState }
  }

  const deltaText = extractString(body, 3)
  if (deltaText !== null) {
    return { event: { type: "text", delta: deltaText }, state: newState }
  }

  // stats-only frame (no delta, no stop, no tool-call) — already accumulated above
  return { event: null, state: newState }
}

// ---------------------------------------------------------------------------
// Main streaming client
// ---------------------------------------------------------------------------

export async function* streamGetChatMessage(
  requestBody: Uint8Array,
  signal?: AbortSignal,
): AsyncGenerator<ResponseEvent> {
  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
    },
    body: Buffer.from(requestBody),
    signal,
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "")
    throw new Error(`GetChatMessage HTTP ${resp.status}: ${errText.slice(0, 500)}`)
  }

  const reader = resp.body?.getReader()
  if (!reader) throw new Error("Response body is not readable")

  let buffer = new Uint8Array(0)
  let decodeState = freshDecodeState()

  try {
    while (true) {
      if (signal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break

      // Append to buffer
      if (value) {
        const newBuf = new Uint8Array(buffer.byteLength + value.byteLength)
        newBuf.set(buffer)
        newBuf.set(value, buffer.byteLength)
        buffer = newBuf
      }

      // Parse all complete frames from buffer
      let remaining = buffer
      const frames = parseConnectFrames(remaining)
      if (frames.length === 0) continue

      // Calculate consumed bytes
      let consumed = 0
      for (const frame of frames) {
        consumed += 5 + frame.body.byteLength
      }
      buffer = buffer.slice(consumed)

      for (const frame of frames) {
        if (frame.flag & CONNECT_FLAG_EOS) continue // skip EOS/trailer frame

        const { event, state: newState } = decodeFrame(frame.body, decodeState)
        decodeState = newState
        if (event) yield event
      }
    }
  } finally {
    reader.releaseLock()
  }

  // Terminal — if the stream ended (EOS) without an explicit stop_reason frame,
  // emit exactly one finish with accumulated stats.
  if (!decodeState.emittedFinish) {
    yield buildFinishEvent(decodeState)
  }
}
