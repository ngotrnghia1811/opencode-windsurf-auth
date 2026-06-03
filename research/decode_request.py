"""
decode_request.py — Recursive protobuf decoder for Windsurf GetChatMessageRequest.

Usage:
  python3 decode_request.py /tmp/getchat_req_mainchat.bin
  python3 decode_request.py /tmp/getchat_req_nonthink.bin
  python3 decode_request.py --flow /tmp/windsurf_traffic.flow

Handles:
  - Connect unary request framing (1 flag byte + 4-byte BE length + proto body)
  - Recursive protobuf field walking with wire-type awareness
  - UTF-8 string extraction with truncation for long blobs
  - Smart sub-message detection: try string first; recurse if it contains
    non-printable chars (like connect_parse.py does)
  - Identification of known sub-messages with field-name labels
  - Float64 decoding from fixed64 wire type
"""
import struct
import sys
import os


# ---------------------------------------------------------------------------
# Varint
# ---------------------------------------------------------------------------

def parse_varint(buf: bytes, offset: int) -> "tuple[int,int]":
    shift = 0
    result = 0
    while True:
        byte = buf[offset]
        offset += 1
        result |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            break
        shift += 7
    return result, offset


# ---------------------------------------------------------------------------
# Connect framing
# ---------------------------------------------------------------------------

def strip_connect_envelope(data: bytes) -> bytes:
    """Strip the Connect unary request frame: 1 flag byte + 4-byte BE length."""
    if len(data) < 5:
        raise ValueError(f"Data too short for Connect envelope: {len(data)} bytes")
    flag = data[0]
    body_len = struct.unpack(">I", data[1:5])[0]
    body = data[5 : 5 + body_len]
    if len(body) != body_len:
        sys.stderr.write(f"  [WARNING: declared length {body_len} but only {len(body)} bytes]\n")
    return body


# ---------------------------------------------------------------------------
# Float64 / double helper
# ---------------------------------------------------------------------------

def decode_fixed64(le_bytes: bytes) -> float:
    """Decode protobuf fixed64 (little-endian) as float64."""
    if len(le_bytes) < 8:
        return float("nan")
    return struct.unpack("<d", le_bytes[:8])[0]


# ---------------------------------------------------------------------------
# UTF-8 helper with truncation
# ---------------------------------------------------------------------------

def try_decode_utf8(b: bytes) -> "str | None":
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return None


def show_string(val: bytes, max_len: int = 120) -> str:
    """Show a string, truncated if long, with length annotation."""
    s = try_decode_utf8(val)
    if s is None:
        return f"<binary {len(val)} bytes: {val[:20].hex()}>"
    if len(s) <= max_len:
        return repr(s)
    return f"'{s[:max_len]}...' ({len(s)} chars)"


def is_printable_ascii(sample: str) -> bool:
    """Check if the first portion of a string is mostly printable ASCII."""
    return all(32 <= ord(c) < 127 or ord(c) in (9, 10, 13) for c in sample)


# ---------------------------------------------------------------------------
# Known field labels (guessed proto names)
# ---------------------------------------------------------------------------

CLIENT_INFO_FIELDS = {
    1:  "client_name",
    2:  "client_version",
    3:  "jwt_token",
    4:  "locale",
    5:  "platform",
    7:  "client_version_2",
    12: "client_name_2",
    31: "integrity_blob",
}

MESSAGE_FIELDS = {
    1: "msg_id",
    2: "role",
    3: "content_text",
    6: "tool_call",       # f6 = ChatToolCall sub-message (on assistant messages, role=2)
    7: "tool_call_id",   # f7 = tool_call_id string (on tool-result messages, role=4)
}

CHAT_TOOL_CALL_FIELDS = {
    1: "tool_call_id",
    2: "tool_name",
    3: "arguments_json",
}

ROLE_NAMES = {
    1: "user",
    2: "assistant",
    4: "tool_result",
}

TOOL_FIELDS = {
    1: "name",
    2: "description",
    3: "parameters_json_schema",
}

TOP_FIELDS = {
    1:  "client_info",
    2:  "system_prompt",
    3:  "messages",
    7:  "unk7_config",
    8:  "model_params",
    10: "tools",
    15: "unk15",
    16: "session_id",
    20: "unk20_bool",
    21: "model_id",
    22: "unk22_uuid",
}

MODEL_PARAMS_FIELDS = {
    1: "unk1",
    2: "max_context_tokens",
    3: "max_output_tokens",
    5: "temperature",
    7: "top_k",
    8: "top_p",
}

UNK15_FIELDS = {
    1: "uuid",
    2: "unk2",
    3: "unk3",
    4: "unk4_think_budget",
}

# Labels to apply at indent==1 (inside known top-level fields)
NESTED_LABELS: dict[int, dict] = {
    1:  CLIENT_INFO_FIELDS,
    3:  MESSAGE_FIELDS,
    8:  MODEL_PARAMS_FIELDS,
    10: TOOL_FIELDS,
    15: UNK15_FIELDS,
}

# Cascaded labels: when recursing into field X inside parent context Y, use these
# (parent_field, child_field) -> label_dict
CASCADED_LABELS: dict[tuple[int, int], dict] = {
    (3, 6): CHAT_TOOL_CALL_FIELDS,  # f6 (tool_call) inside f3 (message)
}


# ---------------------------------------------------------------------------
# Recursive field dumper
# ---------------------------------------------------------------------------

def _dump_proto(buf: bytes, indent: int = 0, max_depth: int = 5,
                field_labels: dict | None = None,
                parent_field: int = 0) -> list[str]:
    """Walk proto fields and return list of description lines.

    Uses connect_parse.py's proven heuristic:
    - Length-delimited field: try UTF-8 decode → if printable, show as string
    - If it contains non-printable chars near the start, treat as sub-message (recurse)
    - If UTF-8 decode fails (binary blob), show as hex or recurse
    """
    lines = []
    pad = "  " * indent
    i = 0
    while i < len(buf):
        try:
            tag, i = parse_varint(buf, i)
        except IndexError:
            break
        field_num = tag >> 3
        wire_type = tag & 7

        label = ""
        if field_labels:
            lbl = field_labels.get(field_num, "")
            if lbl:
                label = f" ({lbl})"

        # Role value annotation
        role_annotation = ""
        if field_labels is MESSAGE_FIELDS and field_num == 2 and wire_type == 0:
            # We'll annotate after reading the value below
            pass

        if wire_type == 0:  # varint
            v, i = parse_varint(buf, i)
            role_note = ""
            if field_labels is MESSAGE_FIELDS and field_num == 2:
                role_note = f" ({ROLE_NAMES.get(v, '?')})"
            lines.append(f"{pad}f{field_num}{label} (varint): {v}{role_note}")

        elif wire_type == 5:  # fixed32
            val = buf[i : i + 4]
            i += 4
            lines.append(f"{pad}f{field_num}{label} (fixed32): {val.hex()}")

        elif wire_type == 1:  # fixed64
            val = buf[i : i + 8]
            i += 8
            f64 = decode_fixed64(val)
            lines.append(f"{pad}f{field_num}{label} (fixed64): float64={f64:.6g}")

        elif wire_type == 2:  # length-delimited
            ln, i = parse_varint(buf, i)
            val = buf[i : i + ln]
            i += ln

            # Try string decode
            s = try_decode_utf8(val)
            if s is not None and ln > 0:
                # Check if the first 60 chars are printable (connect_parse.py heuristic)
                sample = s[:60]
                if is_printable_ascii(sample):
                    # Looks like a string field — show as text
                    lines.append(f"{pad}f{field_num}{label} (str/{ln}): {show_string(val, max_len=120)}")
                elif indent < max_depth:
                    # Non-printable but valid UTF-8 — likely embedded proto, recurse
                    sub_labels = _get_sub_labels(indent, field_num, parent_field)
                    lines.append(f"{pad}f{field_num}{label} (msg/{ln}):")
                    lines.extend(_dump_proto(val, indent + 1, max_depth, sub_labels, parent_field=field_num))
                else:
                    lines.append(f"{pad}f{field_num}{label} (bytes/{ln}): {val[:30].hex()}...")
            elif indent < max_depth and ln > 0:
                # Not valid UTF-8 — try recursing as sub-message
                sub_labels = _get_sub_labels(indent, field_num, parent_field)
                lines.append(f"{pad}f{field_num}{label} (msg/{ln}):")
                lines.extend(_dump_proto(val, indent + 1, max_depth, sub_labels, parent_field=field_num))
            else:
                lines.append(f"{pad}f{field_num}{label} (bytes/{ln}): {val[:30].hex()}{'...' if ln > 30 else ''}")

        else:
            lines.append(f"{pad}! unknown wire_type={wire_type} at field={field_num}")
            break

    return lines


def _get_sub_labels(indent: int, field_num: int, parent_field: int) -> dict | None:
    """Determine the sub-label dict for recursing into a sub-message."""
    if indent == 0:
        return NESTED_LABELS.get(field_num)
    if parent_field > 0:
        return CASCADED_LABELS.get((parent_field, field_num))
    return None


# ---------------------------------------------------------------------------
# Top-level decoder
# ---------------------------------------------------------------------------

def decode_request(data: bytes, strip_envelope: bool = True) -> list[str]:
    """Decode a GetChatMessageRequest (raw bytes with optional Connect envelope)."""
    if strip_envelope:
        body = strip_connect_envelope(data)
    else:
        body = data

    lines = [f"Proto body: {len(body)} bytes", "=" * 60]
    lines.extend(_dump_proto(body, field_labels=TOP_FIELDS))
    return lines


# ---------------------------------------------------------------------------
# Flow file extraction
# ---------------------------------------------------------------------------

def extract_requests_from_flow(flow_path: str) -> list[tuple[int, bytes]]:
    """Extract all GetChatMessage REQUEST bodies from a mitmproxy .flow file.
    Returns list of (index, raw_bytes) tuples."""
    from mitmproxy import io, http

    results = []
    with open(flow_path, "rb") as f:
        idx = 0
        for flow in io.FlowReader(f).stream():
            if not isinstance(flow, http.HTTPFlow):
                continue
            if "GetChatMessage" not in flow.request.pretty_url:
                continue
            if flow.request.raw_content:
                results.append((idx, flow.request.raw_content))
            idx += 1
    return results


# ---------------------------------------------------------------------------
# Stats summary
# ---------------------------------------------------------------------------

def summarize_request(data: bytes) -> dict:
    """Return a high-level summary of a GetChatMessageRequest."""
    body = strip_connect_envelope(data)
    lines = _dump_proto(body, field_labels=TOP_FIELDS, max_depth=1)

    summary = {
        "proto_size": len(body),
        "total_size": len(data),
    }

    for line in lines:
        line = line.strip()
        if line.startswith("f1 (client_info)"):
            summary["has_client_info"] = True
        elif line.startswith("f2 (system_prompt)"):
            if "(str/" in line:
                sln = line.split("(str/")[1].split(")")[0]
                summary["system_prompt_chars"] = int(sln)
        elif line.startswith("f3 (messages)"):
            summary["msg_count"] = summary.get("msg_count", 0) + 1
        elif line.startswith("f10 (tools)"):
            summary["tool_count"] = summary.get("tool_count", 0) + 1
        elif line.startswith("f21 (model_id)"):
            parts = line.split(": ")
            if len(parts) >= 2:
                q = parts[-1].strip("'\"")
                summary["model_id"] = q.split("'")[0] if "'" in q else q

    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <request.bin> [request2.bin ...]", file=sys.stderr)
        print(f"       {sys.argv[0]} --flow <flowfile.flow>", file=sys.stderr)
        sys.exit(1)

    if sys.argv[1] == "--flow":
        flow_path = sys.argv[2]
        print(f"Extracting GetChatMessage requests from: {flow_path}")
        print()
        try:
            requests = extract_requests_from_flow(flow_path)
        except ImportError:
            print("ERROR: mitmproxy not available. Install with: pip install mitmproxy")
            sys.exit(1)

        for idx, raw in requests:
            print(f"\n{'='*60}")
            print(f"REQUEST #{idx} ({len(raw)} bytes total, {len(raw)-5} bytes proto)")
            print(f"{'='*60}")
            for line in decode_request(raw):
                print(line)
    else:
        for path in sys.argv[1:]:
            data = open(path, "rb").read()
            print(f"\n{'='*60}")
            print(f"FILE: {os.path.basename(path)} ({len(data)} bytes)")
            print(f"{'='*60}")
            for line in decode_request(data):
                print(line)

            # Print summary
            print(f"\n--- SUMMARY ---")
            s = summarize_request(data)
            for k, v in sorted(s.items()):
                print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
