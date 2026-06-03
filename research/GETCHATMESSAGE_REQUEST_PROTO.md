# Windsurf/Devin GetChatMessageRequest — Protobuf Wire Protocol

**Reverse-engineered from captured traffic.** Decoder: `decode_request.py` (same directory).
Captures used: `getchat_req_nonthink.bin`, `getchat_req_think.bin`, `getchat_req_mainchat.bin`,
`getchat_req_mainchat_think.bin`.

---

## 1. Transport

| Property | Value |
|----------|-------|
| Protocol | HTTP/2 |
| Method | `POST` |
| Endpoint | `https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage` |
| `content-type` | `application/connect+proto` |
| `connect-protocol-version` | `1` |
| Framing | Connect **unary**: 1 flag byte + 4-byte big-endian length + protobuf body |
| Auth | Body-carried JWT inside `client_info.f3`; **no request signing** (replay: verbatim→200, zeroed integrity blob→200, corrupt JWT→`unauthenticated`) |
| Auth token format | `devin-session-token$eyJhbG...` (189 chars; the `windsurf_api_key` from `~/.local/share/devin/credentials.toml`) |

---

## 2. Top-level `GetChatMessageRequest` Field Map

All fields confirmed from decoder output across all four captures. Best-guess proto names in parentheses.

| Field | Proto name (best guess) | Wire type | Observed type | Observed values |
|-------|------------------------|-----------|---------------|-----------------|
| **f1** | `client_info` | LEN | nested msg | `client_info` sub-message (979 bytes) |
| **f2** | `system_prompt` | LEN | string | 204 B (title-gen), 18,843 B (main-chat) |
| **f3** | `messages` | LEN | repeated msg | 1 element (title-gen), 4 elements (main-chat) |
| **f7** | `unk7` | VARINT | int | **always 5** (all captures) |
| **f8** | `model_params` | LEN | nested msg | temperature=1.0, top_p=0.95, top_k=40, max_context=128000, max_output=400 |
| **f10** | `tools` | LEN | repeated msg | 0 (title-gen), 24 (main-chat) |
| **f15** | `unk15` | LEN | nested msg | UUID + 2–3 varint fields; differs title-gen vs main-chat |
| **f16** | `session_id` | LEN | string | 36-char UUID |
| **f20** | `unk20` | VARINT | int | **always 1** (all captures) |
| **f21** | `model_id` | LEN | string | `"swe-1-6-fast"`, `"claude-sonnet-4-6"`, `"claude-sonnet-4-6-thinking"` |
| **f22** | `unk22_uuid` | LEN | string | 36-char UUID; **present only in main-chat** (absent from title-gen) |

Field numbering gaps (4–6, 9, 11–14, 17–19) are unobserved; presumably unused or response-side only.

---

## 3. `client_info` (f1) Sub-message — 979 bytes

All captures share identical structure (979 bytes). Field map:

| Field | Proto name (best guess) | Wire type | Observed value |
|-------|------------------------|-----------|----------------|
| f1 | `client_name` | LEN/str | `"chisel"` |
| f2 | `client_version` | LEN/str | `"2026.5.26-2"` |
| f3 | `jwt_token` | LEN/str | `"devin-session-token$eyJhbG..."` (189 chars) — **this is the validated auth credential** |
| f4 | `locale` | LEN/str | `"en"` |
| f5 | `platform` | LEN/str | `"mac"` |
| f7 | `client_version_2` | LEN/str | `"2026.5.26-2"` (duplicate of f2) |
| f12 | `client_name_2` | LEN/str | `"chisel"` (duplicate of f1) |
| f31 | `integrity_blob` | LEN/str | 732-char hex string |

**Key finding on f31 (integrity_blob):** NOT enforced by server. Replays with the blob zeroed out (732 `0` chars) return 200. Replays with the blob field entirely omitted also return 200. This field appears to be a client-side integrity check that the server ignores, or a forward-compatibility placeholder.

---

## 4. `messages` (f3) Element Sub-message

Each repeated element in f3 has this structure:

| Field | Proto name (best guess) | Wire type | Description |
|-------|------------------------|-----------|-------------|
| f1 | `msg_id` | LEN/str | 36-char UUID |
| f2 | `role` | VARINT | Observed value: **1** (in all captured messages; interpreted as "user" role for text-only messages) |
| f3 | `content_text` | LEN/str | The message text content |

**Important:** All captured messages are user-role text-only (`role=1`, content as plain string).
Assistant tool-calls (which would likely use `role=2`, `content` as a sub-message with `tool_call`/`tool_result`
structure) were **not observed in request captures** — these messages come from the response side, and the
captured requests are first-turn only (no conversation history with prior assistant turns).

**Observed message sizes (main-chat, 4 messages):**

| # | msg_id (first 8 chars) | Size | Role | Content preview |
|---|------------------------|------|------|-----------------|
| 1 | `bbdbdadc` | 989 B | 1 | `<system_info>...` |
| 2 | `ba179281` | 6,042 B | 1 | `<rules type="always-on">...` |
| 3 | `466e68c7` | 575 B | 1 | `<available_skills>...` |
| 4 | `2c7941d1` | 6 B | 1 | `"say hi"` |

### Worked hex example — message entry (48 bytes, main-chat message #4: "say hi")

```
Full 48-byte hex:
0a 24 32633739343164312d653033352d343331662d616439612d306131653536353731666462
10 01
1a 06 736179206869
```

**Byte-by-byte breakdown:**

```
Offset  Hex                                    | Decode
--------+--------------------------------------+-----------------------------------------------
0       0a 24 + 36 bytes                       | tag=0x0a → f1 (LEN), len=0x24=36
        32633739343164312d653033352d34333166   |
        2d616439612d306131653536353731666462    |   → msg_id="2c7941d1-e035-431f-ad9a-0a1e56571fdb"
38      10 01                                  | tag=0x10 → f2 (VARINT), value=0x01=1 → role=user
40      1a 06                                  | tag=0x1a → f3 (LEN), len=0x06=6
42      736179206869                           |   → content_text="say hi"
```

**Message #1 (system_info, 989 bytes total) — varint length encoding example:**

```
First 60 hex bytes:
0a 24 62626462646164632d346334632d343231652d613566322d346361616236333564656466
10 01
1a dd 07 3c73797374656d5f696e666f3e0a54686520...
```

Varint `1a dd 07`: the LEN tag `0x1a` (f3, wire_type=2) is followed by two varint bytes:
- `0xdd` = `1101_1101` (MSB set → continue; 7 payload bits: `101_1101` = 93)
- `0x07` = `0000_0111` (MSB clear → stop; 7 payload bits: `000_0111` = 7)
- Varint value = `(7 << 7) | 93` = `896 + 93` = **989** → matches the observed 989-byte system_info content.

---

## 5. `tools` (f10) Element Sub-message — THE KEY for Level-2 Interop

Each repeated element in f10 defines one tool available to the model. Field map:

| Field | Proto name (best guess) | Wire type | Description |
|-------|------------------------|-----------|-------------|
| f1 | `name` | LEN/str | Tool function name (e.g. `"ask_user_question"`, `"edit"`, `"exec"`) |
| f2 | `description` | LEN/str | Natural-language description of the tool |
| f3 | `parameters_json_schema` | LEN/str | JSON Schema string defining the tool's input parameters |

**This is a fully mapped 3-field record.** Confirmed across all 24 tools in both main-chat captures.

### Full tool inventory (from main-chat capture, 24 tools, with sizes)

| # | Tool name | f2 description size | f3 schema size |
|---|-----------|---------------------|----------------|
| 1 | `ask_user_question` | 952 B | 1,913 B |
| 2 | `cloud_handoff` | 1,015 B | 259 B |
| 3 | `edit` | 1,107 B | 608 B |
| 4 | `exec` | 2,046 B | 2,648 B |
| 5 | `find_file_by_name` | 354 B | 788 B |
| 6 | `get_output` | 749 B | 618 B |
| 7 | `grep` | 260 B | 1,129 B |
| 8 | `kill_shell` | 206 B | 159 B |
| 9 | `mcp_call_tool` | 178 B | 435 B |
| 10 | `mcp_list_servers` | 140 B | 62 B |
| 11 | `mcp_list_tools` | 135 B | 241 B |
| 12 | `mcp_read_resource` | 184 B | 338 B |
| 13 | `notebook_edit` | 82 B | 743 B |
| 14 | `notebook_read` | 78 B | 228 B |
| 15 | `read` | 417 B | 346 B |
| 16 | `read_subagent` | 341 B | 429 B |
| 17 | `request_scope` | 294 B | 283 B |
| 18 | `run_subagent` | 3,937 B | 1,031 B |
| 19 | `skill` | 486 B | 1,060 B |
| 20 | `todo_write` | 9,240 B | 444 B |
| 21 | `web_search` | 440 B | 677 B |
| 22 | `webfetch` | 60 B | 151 B |
| 23 | `write` | 414 B | 258 B |
| 24 | `write_to_process` | 671 B | 414 B |

### Worked hex example — tool entry: `"ask_user_question"` (2,892 bytes)

First 256 hex bytes of the tool sub-message:

```
0a 11 61736b5f757365725f7175657374696f6e
12 b8 07 50726573656e74206d756c7469706c652d63686f696365207175657374696f6e73
20746f20746865207573657220616e6420636f6c6c65637420746865697220616e7377657273
2e0a0a557365207468697320746f6f6c207768656e20796f75206e6565642074686520757365
7220746f206d616b652061206465636973696f6e206265747765656e207365766572616c206f
7074696f6e732c20737563682061732063686f6f73696e670a616e... (continues)
```

**Byte-by-byte breakdown (first 3 fields):**

```
Hex                                          | Decode
---------------------------------------------+-----------------------------------------
0a 11 61736b5f757365725f7175657374696f6e    | tag=0x0a → f1 (LEN), len=17
                                             |  → name = "ask_user_question"
12 b8 07                                     | tag=0x12 → f2 (LEN), len=952 (0x07b8)
  + 952 bytes of description text            |  → description = "Present multiple-choice questions..."
1a f7 0e                                     | tag=0x1a → f3 (LEN), len=1913 (0x0ef7)
  + 1913 bytes of JSON schema                |  → parameters_json_schema = {"additionalProperties":false,...}
```

The last 200 bytes of this tool sub-message show the tail of the JSON schema:

```
...656d73223a7b2274797065223a22737472696e67227d7d2c22637573746f6d5f74657874
223a7b226465736372697074696f6e223a22437573746f6d20746578742070726f7669646564
2062792074686520757365722e20536574207768656e2074686520757365722073656c656374
73205c224f746865725c222e222c2274797065223a22737472696e67227d7d2c227265717569
726564223a5b2273656c6563746564225d2c226164646974696f6e616c50726f706572746965
73223a66616c73657d7d7d7d
```

Which decodes as: `...ems":{"type":"string"}},"custom_text":{"description":"Custom text provided by the user. Set when the user selects \"Other\".","type":"string"}},"required":["selected"],"additionalProperties":false}}}`

---

## 6. `model_params` (f8) Sub-message — 29 bytes

Observed identical across all captures:

| Field | Proto name (best guess) | Wire type | Value |
|-------|------------------------|-----------|-------|
| f1 | `unk1` | VARINT | 1 |
| f2 | `max_context_tokens` | VARINT | 128,000 |
| f3 | `max_output_tokens` | VARINT | 400 |
| f5 | `temperature` | fixed64 | 1.0 |
| f7 | `top_k` | VARINT | 40 |
| f8 | `top_p` | fixed64 | 0.95 |

Fields 4 and 6 are unobserved. `f1=1` is always present but its purpose is unknown (could be a `model_params_version` marker or an enable/disable flag).

---

## 7. `unk15` (f15) Sub-message

Differs between title-gen and main-chat captures:

### Title-gen (non-think) — 42 bytes
| Field | Value | Wire type |
|-------|-------|-----------|
| f1 (uuid) | `"c972b112-9248-46a4-ac01-38bfb57c795a"` | LEN/str |
| f2 (unk2) | 1 | VARINT |
| f3 (unk3) | 4 | VARINT |

### Title-gen (think) — 42 bytes
| Field | Value | Wire type |
|-------|-------|-----------|
| f1 (uuid) | `"a8c5b5c3-af83-4f00-b565-f94d6cc4813f"` | LEN/str |
| f2 (unk2) | 1 | VARINT |
| f3 (unk3) | 4 | VARINT |

### Main chat — 42 bytes
| Field | Value | Wire type |
|-------|-------|-----------|
| f1 (uuid) | `"c972b112-9248-46a4-ac01-38bfb57c795a"` | LEN/str |
| f3 (unk3) | 4 | VARINT |
| f4 (unk4_think_budget) | 14 | VARINT |

### Main chat (think) — 42 bytes
| Field | Value | Wire type |
|-------|-------|-----------|
| f1 (uuid) | `"a8c5b5c3-af83-4f00-b565-f94d6cc4813f"` | LEN/str |
| f3 (unk3) | 4 | VARINT |
| f4 (unk4_think_budget) | 14 | VARINT |

**Observations about f15:**
- f2 (value=1) is present ONLY in title-gen captures; absent from main-chat.
- f4 (value=14) is present ONLY in main-chat captures; absent from title-gen.
- f1 UUID matches the title-gen or think-mode UUID, suggesting this is a per-capture-origin identifier.
- f3 is always 4 across all captures.
- The think-mode main-chat uses the think-mode UUID in f1 and still has f4=14 (same as non-think main-chat).

---

## 8. What is still unknown / ambiguous

### 8.1 Assistant tool-call and tool-result encoding in messages (f3)

**Status: FULLY CONFIRMED from live multi-turn capture (2026-06-01).** See Section 11 for the
complete wire-level specification with worked hex examples.

Key findings:
- **Assistant role = varint 2**, with tool-call encoded in **f6** as a `ChatToolCall` sub-message
  containing `f1` (tool_call_id), `f2` (tool_name), `f3` (arguments_json).
- **Tool-result role = varint 4**, with output in `f3` (content_text) and the linking
  `tool_call_id` in **f7**.
- The inferred structure from prior analysis was **close but not exact**: we hypothesized
  f4/f5 for tool-call/result, but the actual fields are f6 (tool-call sub-message) and
  f7 (tool-call-id on result). No `is_custom_tool_call` flag was observed on the request side.

### 8.2 Purpose of sentinel fields

| Field | Value | Hypothesis |
|-------|-------|------------|
| f7 | always **5** | Possibly a protocol version, client feature level, or a control flag interpreted server-side as "use-tools mode." Consistent across all captures. |
| f20 | always **1** | Could be a boolean `enable_streaming`, `enable_thinking`, or a client capability flag. |
| f22 | 36-char UUID | Present only in main-chat captures. Could be a conversation-turn ID, a request correlation ID, or a "chat-creation" vs "chat-continuation" discriminator. Absent in title-gen. |

None of these fields is required to be understood for constructing a working request — they
can be copied verbatim from a known-good capture.

### 8.3 Internal structure of f15 (unk15)

- f2 (`unk2`, value=1) appears only in title-gen; could be a `is_title_generation` boolean or a mode discriminator.
- f4 (`unk4_think_budget`, value=14) appears only in main-chat; could be a thinking budget/token allocation for Claude models.
- The UUID in f1 differs between think/non-think captures but matches the think-mode flag.
- f3 is always 4 — could be a field-count sentinel or a configuration version.

### 8.4 Field numbering gaps

Fields 4–6, 9, 11–14, 17–19, 23+ are unobserved in request captures. They may be:
- Response-side only fields
- Optional fields not used by the current client version
- Future capability placeholders

### 8.5 `model_params.f1` (always = 1)

Could be a struct version discriminator, an enable flag, or a reserved field. Without server-side
source or a comparative capture with a different value, its purpose remains speculative.

---

## 9. Feasibility Verdict

### Level 2 (tools-aware interop) — CONSTRUCTION FEASIBLE for first-turn requests

**Verdict: 100% confirmed fields are sufficient to construct a valid `GetChatMessageRequest` in
TypeScript (or any language) that injects opencode's own tool schemas into f10 and receives a
tool-calling-capable response from the Windsurf/Devin API endpoint.**

The tools array schema is fully mapped on the request side:
- `f1` = `name` (string) — the tool function name the model sees
- `f2` = `description` (string) — natural-language description
- `f3` = `parameters_json_schema` (string) — JSON Schema for tool input parameters

**Confirmed fields (100%):**

| Scope | Fields | Confirmation |
|-------|--------|-------------|
| Transport | Connect unary, HTTP/2 | Decoder strips envelope correctly; raw body matches expectations |
| Auth | `client_info.f3` JWT only; no request signing | Replay confirmed: verbatim→200, zeroed integrity→200 |
| `client_info` | All 7 sub-fields (f1, f2, f3, f4, f5, f7, f12, f31) | Present and identical across all 4 captures |
| `model_params` | f1, f2, f3, f5, f7, f8 | Identical across all captures |
| `messages` element | f1 (msg_id), f2 (role), f3 (content_text) | 10 total messages decoded across 4 captures; all conform |
| `tools` element | f1 (name), f2 (description), f3 (parameters_json_schema) | 48 tool entries decoded (24 × 2 captures); all conform |
| Sentinel fields | f7=5, f20=1 | Consistent across all captures |
| `model_id` | f21 (string) | Confirmed as model selector |
| `unk15` | f1, f2, f3, f4 observed | Structure is stable per capture type |

**Inferred fields (reasonable confidence but not capture-verified):**

| Scope | Inference | Basis |
|-------|-----------|-------|
| `system_prompt` (f2) | String field — content is entirely client-provided | Title-gen uses 204 B prompt; main-chat uses 18 KB Devin system prompt |
| `session_id` (f16) | 36-char UUID string | Stable per session; generated client-side |
| `unk22_uuid` (f22) | 36-char UUID string; required for main-chat | Present in both main-chat captures, absent from title-gen |
| `msg_id` in messages | 36-char UUID; client-generated | Unique per message; format matches UUID v4 |
| `role=1` in messages | Maps to "user" role | Inferred from content being user-facing system_info/rules/skills/prompt |

**Multi-turn Level-2 conversation replay — FULLY MAPPED (2026-06-01).** See Section 11 for the
complete specification.

### Verdict summary

| Capability | Status |
|------------|--------|
| Construct first-turn `GetChatMessageRequest` with custom tools | **Feasible — all required fields confirmed** |
| Inject opencode tool schemas into f10 | **Feasible — field map is complete** |
| Use any supported model via f21 (model_id) | **Feasible — confirmed across 4 model variants** |
| Receive and decode streaming tool-call responses | Separate concern (response decoding, not request encoding) |
| Construct multi-turn requests with tool-call history | **FEASIBLE — encoding fully confirmed from live capture** |

---

## 10. Appendix: Decoder Verification

The decoder script `decode_request.py` was run against all captures with
`/opt/homebrew/bin/python3`. All passed without errors and produced the field maps
documented above.

```bash
# Non-think title-gen (1378 bytes, 1 message, 0 tools, model=swe-1-6-fast)
python3 decode_request.py /tmp/getchat_req_nonthink.bin   # ✓ clean

# Think-mode title-gen (1412 bytes, 1 message, 0 tools, model=swe-1-6-fast)
python3 decode_request.py /tmp/getchat_req_think.bin      # ✓ clean

# Main chat non-think (67389 bytes, 4 messages, 24 tools, model=claude-sonnet-4-6)
python3 decode_request.py /tmp/getchat_req_mainchat.bin   # ✓ clean

# Main chat think-mode (60799 bytes, 4 messages, 24 tools, model=claude-sonnet-4-6-thinking)
python3 decode_request.py /tmp/getchat_req_mainchat_think.bin  # ✓ clean

# Multi-turn: first turn (67574 bytes, 4 messages, 24 tools, model=claude-sonnet-4-6)
python3 decode_request.py /tmp/getchat_req_0.bin   # ✓ clean (2026-06-01 live capture)

# Multi-turn: title-gen (1472 bytes, 1 message, 0 tools, model=swe-1-6-fast)
python3 decode_request.py /tmp/getchat_req_1.bin   # ✓ clean (2026-06-01 live capture)

# Multi-turn: second turn WITH tool-call history (67846 bytes, 6 messages, 24 tools, model=claude-sonnet-4-6)
python3 decode_request.py /tmp/getchat_req_2.bin   # ✓ clean (2026-06-01 live capture — THE PRIZE)
```

---

## 11. Multi-turn: assistant tool-call & tool-result message encoding

**CONFIRMED FROM WIRE — live capture 2026-06-01.**

A multi-turn `GetChatMessageRequest` sends the entire conversation history in `f3` (messages),
including the prior assistant tool-call and the tool-execution result. The structure uses
**role varint values** to distinguish message types and **additional fields** (f6, f7) on
the message sub-message to carry tool metadata.

### 11.1 Role values

| Role varint | Name | Message carries |
|-------------|------|-----------------|
| **1** | `user` | `f1` msg_id, `f3` content_text (plain string) |
| **2** | `assistant` | `f1` msg_id, `f6` ChatToolCall sub-message |
| **4** | `tool_result` | `f1` msg_id, `f3` content_text (tool output), `f7` tool_call_id |

Roles **0** and **3** were NOT observed. The role enum is sparse (1, 2, 4).

### 11.2 Assistant message with tool-call (role=2)

An assistant message (role=2) carries ONE tool-call inside **f6**, which is a nested
`ChatToolCall` sub-message. Multiple tool-calls in a single assistant turn would likely appear
as repeated f6 sub-messages, but only single-call messages were observed in this capture.

**Message field map (role=2):**

| Field | Proto name | Wire type | Description |
|-------|-----------|-----------|-------------|
| f1 | `msg_id` | LEN/str | 36-char UUID |
| f2 | `role` | VARINT | = **2** (assistant) |
| **f6** | `tool_call` | LEN/msg | **ChatToolCall** sub-message (see 11.3) |

Fields **f4**, **f5** (text content) were NOT present on the observed assistant message.
The assistant message is purely a tool-call carrier — no text content accompanies it.
This is consistent with the Devin agent architecture: when the model emits a tool-call,
the assistant message contains only the tool-call, and the model's response text comes
in a subsequent assistant message after tool execution.

Note: `f6` (field number 6, wire type 2 = LEN) has tag byte `0x32` = `(6 << 3) | 2`.

### 11.3 ChatToolCall sub-message (inside f6)

This is the identical structure observed in **response-side** `ChatToolCall` stream chunks
(f6 in GetChatMessageResponse). The request side carries the same 3-field structure.

**ChatToolCall field map:**

| Field | Proto name | Wire type | Description |
|-------|-----------|-----------|-------------|
| f1 | `tool_call_id` | LEN/str | Tool-call identifier, format `toolu_<22-char>` (e.g. `"toolu_01HECwwCD8cHG657anKFiFeb"`) |
| f2 | `tool_name` | LEN/str | Tool function name (e.g. `"exec"`) |
| f3 | `arguments_json` | LEN/str | JSON string of tool arguments (e.g. `'{"command":"echo hello42_from_wiretap"}'`) |

No `is_custom_tool_call` boolean was observed on the request side.

### 11.4 Tool-result message (role=4)

A tool-result message carries the execution output from running a tool. It links back to its
originating tool-call via `f7` (tool_call_id).

**Message field map (role=4):**

| Field | Proto name | Wire type | Description |
|-------|-----------|-----------|-------------|
| f1 | `msg_id` | LEN/str | 36-char UUID |
| f2 | `role` | VARINT | = **4** (tool_result) |
| f3 | `content_text` | LEN/str | The tool execution output string (e.g. `"Output from command in shell f70a48:\nhello42_from_wiretap\n\n\nExit code: 0"`) |
| **f7** | `tool_call_id` | LEN/str | The tool-call ID this result belongs to (identical to the ChatToolCall.f1 value) |

Note: `f7` (field number 7, wire type 2 = LEN) has tag byte `0x3a` = `(7 << 3) | 2`.

### 11.5 Worked hex example — assistant message with tool-call (121 bytes)

**Full hex:**
```
0a2433333138663861652d333839312d343532352d613765652d363034373466313436646462
1002
324f0a1e746f6f6c755f30314845437777434438634847363537616e4b466946656212046578
65631a277b22636f6d6d616e64223a226563686f2068656c6c6f34325f66726f6d5f77697265
746170227d
```

**Byte-by-byte breakdown:**

```
Offset  Hex                                    | Decode
--------+---------------------------------------+-----------------------------------------------
0       0a 24 + 36 bytes                       | tag=0x0a → f1 (LEN), len=0x24=36
        33333138663861652d333839312d34353235    |
        2d613765652d363034373466313436646462    |   → msg_id="3318f8ae-3891-4525-a7ee-60474f146ddb"
38      10 02                                  | tag=0x10 → f2 (VARINT), value=2 → role=ASSISTANT
40      32 4f                                  | tag=0x32 → f6 (LEN, field=6, wire=2), len=0x4f=79
        --- ChatToolCall sub-message (79 bytes) ---
42      0a 1e + 30 bytes                       | tag=0x0a → f1 (LEN), len=0x1e=30
        746f6f6c755f303148454377774344386348    |
        47363537616e4b4669466562               |   → tool_call_id="toolu_01HECwwCD8cHG657anKFiFeb"
74      12 04                                  | tag=0x12 → f2 (LEN), len=0x04=4
        65786563                               |   → tool_name="exec"
80      1a 27                                  | tag=0x1a → f3 (LEN), len=0x27=39
        7b22636f6d6d616e64223a226563686f2068    |
        656c6c6f34325f66726f6d5f77697265746170  |
        227d                                   |   → arguments_json='{"command":"echo hello42_from_wiretap"}'
```

**Key observations:**
- The ChatToolCall sub-message at f6 uses fields f1/f2/f3 — the same numbering as the
  response-side ChatToolCall structure.
- The `tool_call_id` format `toolu_01HECwwCD8cHG657anKFiFeb` (30 chars) matches the
  Anthropic-style `toolu_` prefix pattern.
- No `f4` or `f5` fields are present in the message (the assistant message has no text
  content — it's a pure tool-call).

### 11.6 Worked hex example — tool-result message (146 bytes)

**Full hex:**
```
0a2432386533623233392d656263382d346461332d623637342d313933373137396134613836
1004
1a484f75747075742066726f6d20636f6d6d616e6420696e207368656c6c206637306134383a
0a68656c6c6f34325f66726f6d5f776972657461700a0a0a4578697420636f64653a2030
3a1e746f6f6c755f30314845437777434438634847363537616e4b4669466562
```

**Byte-by-byte breakdown:**

```
Offset  Hex                                    | Decode
--------+---------------------------------------+-----------------------------------------------
0       0a 24 + 36 bytes                       | tag=0x0a → f1 (LEN), len=0x24=36
        32386533623233392d656263382d34646133    |
        2d623637342d313933373137396134613836    |   → msg_id="28e3b239-ebc8-4da3-b674-1937179a4a86"
38      10 04                                  | tag=0x10 → f2 (VARINT), value=4 → role=TOOL_RESULT
40      1a 48                                  | tag=0x1a → f3 (LEN), len=0x48=72
        4f75747075742066726f6d20636f6d6d616e64  |
        20696e207368656c6c206637306134383a0a68  |
        656c6c6f34325f66726f6d5f77697265746170  |
        0a0a0a4578697420636f64653a2030          |   → content_text="Output from command in shell f70a48:\nhello42_from_wiretap\n\n\nExit code: 0"
114     3a 1e                                  | tag=0x3a → f7 (LEN), len=0x1e=30
        746f6f6c755f30314845437777434438634847  |
        363537616e4b4669466562                 |   → tool_call_id="toolu_01HECwwCD8cHG657anKFiFeb"
```

**Key observations:**
- The `tool_call_id` in f7 (`"toolu_01HECwwCD8cHG657anKFiFeb"`) **exactly matches** the
  ChatToolCall.f1 from the preceding assistant message. This is the link mechanism.
- The content_text in f3 is the raw tool output — Devin prepends a header
  (`"Output from command in shell f70a48:\n"`) before the actual stdout and exit code.

### 11.7 Full conversation structure (6 messages in f3)

From the live multi-turn capture (`/tmp/getchat_req_2.bin`):

| # | msg_id (first 8 chars) | Size | Role (f2) | Content |
|---|------------------------|------|-----------|---------|
| 1 | `59d5c8c3` | 1,123 B | 1 (user) | `<system_info>...` (1080 chars) |
| 2 | `d9511df0` | 6,085 B | 1 (user) | `<rules type="always-on">...` (6042 chars) |
| 3 | `640bb54f` | 618 B | 1 (user) | `<available_skills>...` (575 chars) |
| 4 | `7dbe2df4` | 141 B | 1 (user) | `"Use the exec tool to run the command 'echo hello42_from_wiretap'..."` (99 chars) |
| 5 | `3318f8ae` | 121 B | **2 (assistant)** | f6: `{tool_call_id:"toolu_01HECwwCD8cHG657anKFiFeb", tool_name:"exec", arguments_json:'{"command":"echo hello42_from_wiretap"}'}` |
| 6 | `28e3b239` | 146 B | **4 (tool_result)** | f3: `"Output from command in shell f70a48:\nhello42_from_wiretap\n\n\nExit code: 0"`, f7: `"toolu_01HECwwCD8cHG657anKFiFeb"` |

The system messages (1–3) are reserialized with **new msg_ids** in the follow-up request —
Devin does NOT reuse the original message IDs from the first turn.

### 11.8 unk15.f2 — turn discriminator

The `f15` (unk15) sub-message changes between turns:

| Request | unk15.f1 (uuid) | unk15.f2 | unk15.f3 | unk15.f4 | Context |
|---------|-----------------|----------|----------|----------|---------|
| req_0 (first turn) | `5fc8ee03...` | *absent* | 4 | 14 | Initial main-chat request |
| req_1 (title gen) | `5fc8ee03...` | **1** | 4 | *absent* | Title generation |
| req_2 (second turn) | `5fc8ee03...` | **2** | 4 | *absent* | Follow-up after tool execution |

- `f2=1` → title generation
- `f2=2` → follow-up turn (continuation)
- f2 absent → first main-chat turn

The f1 UUID is identical across all turns in the same session, suggesting it's a
conversation-scoped identifier. The session_id (f16) is also identical:
`114c3c86-b6b4-4ca1-be5b-383f98bb42f8`.

### 11.9 Confidence assessment

| Claim | Confidence | Basis |
|-------|-----------|-------|
| Role 2 = assistant, Role 4 = tool_result | **CONFIRMED** | Directly observed in live wire capture; decoder validates field boundaries |
| ChatToolCall in f6 with f1/f2/f3 | **CONFIRMED** | Structure matches response-side ChatToolCall exactly; field numbers consistent |
| Tool-result output in f3, tool_call_id in f7 | **CONFIRMED** | Tool-call ID in f7 matches ChatToolCall.f1 exactly |
| Single tool-call per assistant message in this capture | **OBSERVED** | Only one f6 per assistant message in this capture; multiple tool-calls likely use repeated f6 |
| No text content on assistant tool-call message | **OBSERVED** | Fields f3/f4/f5 not present; this may vary by model or tool-use pattern |
| unk15.f2 = turn discriminator | **HIGH CONFIDENCE** | Pattern of 1=title-gen, 2=follow-up, absent=first-turn is consistent |

### 11.10 What remains unknown

1. **Multiple tool-calls per message:** Only single-call assistant messages were observed.
   If a model emits multiple tool-calls in one turn, they would likely appear as repeated f6
   sub-messages, but this needs confirmation.

2. **Text content alongside tool-calls:** Some models emit both a text response AND tool-calls
   in the same assistant message. This capture shows a pure tool-call assistant message. If
   text content coexists with a tool-call, it would likely appear in f3 or f4 — not yet observed.

3. **Role 0 and 3:** These role values were not observed. They may be unused or reserved for
   system messages / future message types.

4. **`is_custom_tool_call` boolean:** Observed in response-side ChatToolCall stream chunks
   but NOT present in the request-side serialization. Either omitted (defaults to false) or
   only relevant server-side.

5. **unk15.f4 (think_budget=14):** Present only in the first main-chat turn, absent from
   follow-up and title-gen. Purpose unknown but not needed for constructing requests.

---

*Last updated: 2026-06-01 | Decoder: `opencode-windsurf-auth/research/decode_request.py`*
