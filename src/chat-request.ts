// chat-request.ts — encode GetChatMessageRequest protobuf + Connect framing
//
// Field map from:
//   opencode-windsurf-auth/research/GETCHATMESSAGE_REQUEST_PROTO.md
//   opencode-windsurf-auth/research/decode_request.py
//
// Validation: the output of encodeGetChatMessageRequest can be round-trip
// decoded with decode_request.py to verify field counts and structure.

import {
  encodeConnectFrame,
  encodeFixed64Field,
  encodeMessageField,
  encodeStringField,
  encodeVarintField,
} from "./proto"

function uuid(): string {
  return crypto.randomUUID()
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.byteLength, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const a of arrays) {
    result.set(a, offset)
    offset += a.byteLength
  }
  return result
}

// ---------------------------------------------------------------------------
// Sub-message builders
// ---------------------------------------------------------------------------

/** Build the client_info sub-message (f1). */
function encodeClientInfo(jwt: string): Uint8Array {
  return concat(
    encodeStringField(1, "chisel"), // f1: client_name
    encodeStringField(2, "2026.5.26-2"), // f2: client_version
    encodeStringField(3, `devin-session-token$${jwt}`), // f3: jwt_token
    encodeStringField(4, "en"), // f4: locale
    encodeStringField(5, "mac"), // f5: platform
    encodeStringField(7, "2026.5.26-2"), // f7: client_version_2
    encodeStringField(12, "chisel"), // f12: client_name_2
    // f31: integrity_blob — omit (server does not check)
  )
}

/** Build the ChatToolCall sub-message used in f6 of role=2 messages and on the response side.
 *  Fields: f1=tool_call_id, f2=tool_name, f3=arguments_json. */
function encodeChatToolCall(tc: { id: string; name: string; argumentsJson: string }): Uint8Array {
  return concat(
    encodeStringField(1, tc.id),
    encodeStringField(2, tc.name),
    encodeStringField(3, tc.argumentsJson),
  )
}

/** Build one message entry (f3 repeated).
 *  Role 1 (user):         f1=msg_id, f2=1, f3=content_text
 *  Role 2 (assistant):    f1=msg_id, f2=2, [f3=content_text if non-empty,] f6=ChatToolCall
 *  Role 4 (tool_result):  f1=msg_id, f2=4, f3=content_text, f7=tool_call_id
 *  Default (role||1):     same as role=1 for backward compatibility. */
function encodeMessage(
  m: GetChatMessageInput["messages"][number],
): Uint8Array {
  const msgId = uuid()
  const role = m.role || 1

  if (role === 2) {
    const parts: Uint8Array[] = [
      encodeStringField(1, msgId),
      encodeVarintField(2, 2),
    ]
    if (m.content) parts.push(encodeStringField(3, m.content))
    if (m.toolCall) parts.push(encodeMessageField(6, encodeChatToolCall(m.toolCall)))
    return concat(...parts)
  }

  if (role === 4) {
    return concat(
      encodeStringField(1, msgId),
      encodeVarintField(2, 4),
      encodeStringField(3, m.content ?? ""),
      encodeStringField(7, m.toolResult?.toolCallId ?? ""),
    )
  }

  // role=1 (user) — default path
  return concat(
    encodeStringField(1, msgId),
    encodeVarintField(2, role),
    encodeStringField(3, m.content ?? ""),
  )
}

/** Build one tool entry (f10 repeated). */
function encodeTool(
  name: string,
  description: string,
  parametersJsonSchema: string,
): Uint8Array {
  return concat(
    encodeStringField(1, name),
    encodeStringField(2, description),
    encodeStringField(3, parametersJsonSchema),
  )
}

/** Build the model_params sub-message (f8). */
function encodeModelParams(): Uint8Array {
  return concat(
    encodeVarintField(1, 1), // f1: unk1 (=1)
    encodeVarintField(2, 128000), // f2: max_context_tokens
    encodeVarintField(3, 400), // f3: max_output_tokens
    encodeFixed64Field(5, 1.0), // f5: temperature
    encodeVarintField(7, 40), // f7: top_k
    encodeFixed64Field(8, 0.95), // f8: top_p
  )
}

/** Build the unk15 sub-message (f15).
 *
 * Matches the known-good title-gen capture shape: {f1:uuid, f2:1, f3:4}.
 * The main-chat captures additionally carry f4 (a think-budget value) but the
 * minimal title-gen request — proven to be accepted by the server — omits it.
 * We mirror the minimal known-good shape to maximise acceptance. */
function encodeUnk15(): Uint8Array {
  return concat(
    encodeStringField(1, uuid()), // f1: uuid (per-request)
    encodeVarintField(2, 1), // f2: unk2
    encodeVarintField(3, 4), // f3: unk3
  )
}

// ---------------------------------------------------------------------------
// Top-level encoder input
// ---------------------------------------------------------------------------

export interface GetChatMessageInput {
  jwt: string // bare JWT (no prefix)
  systemPrompt: string
  messages: Array<{
    role: number // 1=user, 2=assistant (with tool-call), 4=tool_result
    content?: string // text content; used for all roles
    toolCall?: { id: string; name: string; argumentsJson: string } // role=2: ChatToolCall sub-message in f6
    toolResult?: { toolCallId: string } // role=4: links back to ChatToolCall via f7
  }>
  tools: Array<{ name: string; description: string; parametersJsonSchema: string }>
  modelId: string
  sessionId?: string // 36-char UUID; auto-generated if not provided
}

// ---------------------------------------------------------------------------
// Main encoder
// ---------------------------------------------------------------------------

export function encodeGetChatMessageRequest(input: GetChatMessageInput): Uint8Array {
  const sessionId = input.sessionId ?? uuid()

  const body = concat(
    // f1: client_info
    encodeMessageField(1, encodeClientInfo(input.jwt)),
    // f2: system_prompt
    encodeStringField(2, input.systemPrompt),
    // f3: messages[] (repeated). Role 1=user, 2=assistant (with optional
    // ChatToolCall in f6), 4=tool_result (with tool_call_id in f7).
    ...input.messages.map((m) => encodeMessageField(3, encodeMessage(m))),
    // f7: unk7 = 5
    encodeVarintField(7, 5),
    // f8: model_params
    encodeMessageField(8, encodeModelParams()),
    // f10: tools[] (repeated)
    ...input.tools.map((t) =>
      encodeMessageField(10, encodeTool(t.name, t.description, t.parametersJsonSchema)),
    ),
    // f15: unk15
    encodeMessageField(15, encodeUnk15()),
    // f16: session_id
    encodeStringField(16, sessionId),
    // f20: unk20 = 1
    encodeVarintField(20, 1),
    // f21: model_id
    encodeStringField(21, input.modelId),
    // f22: unk22_uuid — omitted. The known-good minimal (title-gen) request does
    // not carry f22; it only appears in main-chat captures and is not required.
  )

  return encodeConnectFrame(body)
}
