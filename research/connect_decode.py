"""
connect_decode.py — shared Connect-RPC response decoder for Windsurf/Devin.

Handles:
  - Connect streaming frame parsing (flag byte + 4-byte big-endian length)
  - Protobuf wire-format field walking (varints, length-delimited, fixed-width)
  - Extraction of thinking/answer text deltas (f9/f3) with UTF-8 awareness
  - Anthropic redacted_thinking signature frame detection (f10 + f21)
  - Stats-block parsing (model, input/output tokens, msg_id) from f7

Import-safe: no side effects. Pure Python stdlib.
"""

import struct


# ---------------------------------------------------------------------------
# Low-level varint
# ---------------------------------------------------------------------------

def parse_varint(buf: bytes, offset: int) -> tuple[int, int]:
    """Return (value, new_offset) for a protobuf varint."""
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
# Connect streaming framing
# ---------------------------------------------------------------------------

def decode_connect_stream(data: bytes):
    """
    Generator yielding (frame_idx, flag, proto_body) tuples.

    Connect framing: 1 flag byte + 4-byte big-endian length + body.
    flag bit 0x02 set = end-of-stream trailer (body is JSON, not proto).
    We skip EOS frames.
    """
    i = 0
    fidx = 0
    while i + 5 <= len(data):
        flag = data[i]
        body_len = struct.unpack(">I", data[i + 1 : i + 5])[0]
        body = data[i + 5 : i + 5 + body_len]
        i += 5 + body_len

        if flag & 0x02:  # EOS trailer — not proto
            fidx += 1
            continue

        yield fidx, flag, body
        fidx += 1


# ---------------------------------------------------------------------------
# Proto field extraction helpers
# ---------------------------------------------------------------------------

def _try_decode_utf8(b: bytes) -> str | None:
    """Return decoded string, or None if the bytes are not valid UTF-8."""
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _walk_fields(body: bytes) -> list[dict]:
    """
    Walk all top-level proto fields in *body*.
    Returns a list of {"field": int, "wire": int, "value": bytes|int} dicts.
    For wire-0 (varint), value is int; for wire-2, value is the raw bytes;
    for wire-1/5 we skip past with value=None.
    """
    fields = []
    i = 0
    while i < len(body):
        tag, i = parse_varint(body, i)
        field = tag >> 3
        wire = tag & 7
        if wire == 0:  # varint
            v, i = parse_varint(body, i)
            fields.append({"field": field, "wire": wire, "value": v})
        elif wire == 2:  # length-delimited
            ln, i = parse_varint(body, i)
            val = body[i : i + ln]
            i += ln
            fields.append({"field": field, "wire": wire, "value": val})
        elif wire == 1:  # 64-bit fixed
            i += 8
            fields.append({"field": field, "wire": wire, "value": None})
        elif wire == 5:  # 32-bit fixed
            i += 4
            fields.append({"field": field, "wire": wire, "value": None})
        else:
            # Unknown wire type — stop (deprecated group or corruption)
            break
    return fields


def _field_dict(body: bytes) -> dict[int, object]:
    """
    Return a dict mapping field_number -> value for the top-level fields.
    Wire-2 values are raw bytes; wire-0 values are ints.
    Repeated fields are NOT collected — last wins.
    """
    d: dict[int, object] = {}
    for f in _walk_fields(body):
        d[f["field"]] = f["value"]
    return d


def extract_text(body: bytes, field_num: int) -> str | None:
    """
    Extract a text delta from *field_num* in the proto body.

    Strategy: get the raw wire-2 bytes of the field, try UTF-8 decode.
    If it decodes → return the string. If it fails, walk nested fields
    looking for a string (recursive fallback — not needed for observed
    captures, but guards against future format changes).
    """
    for f in _walk_fields(body):
        if f["field"] == field_num and f["wire"] == 2:
            val = f["value"]
            if isinstance(val, bytes):
                txt = _try_decode_utf8(val)
                if txt is not None:
                    return txt
                # fallback: recurse into nested message looking for strings
                for sf in _walk_fields(val):
                    if sf["wire"] == 2 and isinstance(sf["value"], bytes):
                        txt = _try_decode_utf8(sf["value"])
                        if txt is not None:
                            return txt
    return None


def is_signature_frame(body: bytes) -> bool:
    """
    Detect the Anthropic redacted_thinking signature frame.
    Signature frame has f10 (base64 string blob) AND f21 (str) == "anthropic".
    """
    fd = _field_dict(body)
    f10 = fd.get(10)
    f21 = fd.get(21)
    if isinstance(f10, bytes) and isinstance(f21, bytes):
        try:
            if f21.decode("utf-8") == "anthropic":
                return True
        except UnicodeDecodeError:
            pass
    return False


def is_stop_frame(body: bytes) -> bool:
    """Check if the outer message has f5 (stop reason), typically == 4."""
    fd = _field_dict(body)
    return fd.get(5) == 4


def extract_stats(body: bytes) -> dict | None:
    """
    Extract model, token counts, and msg_id from the f7 stats block.

    Returns a dict, or None if f7 is absent or unparseable.

    FIELD MAPPING (documented — see Part A report):
      f7.f9  → model          (string, always)
      f7.f7  → msg_id         (string, always)
      f7.f5  → output_tokens  (int, both old and new API)
      f7.f4  → input_tokens   (int, OLD API — used when present)
      f7.f3  → input_tokens   (int, NEW API — used when f7.f4 is absent)
      f7.f3  → cache_creation_input_tokens (int, OLD API — emitted only when
                both f7.f3 AND f7.f4 are present, as a separate diagnostic field)

    The API response format changed between captures. The old format has
    f7.f4=input_tokens with f7.f3 as a secondary cache-token field. The new
    format dropped f7.f4 and moved input_tokens to f7.f3. We detect which
    scheme is active by testing whether f7.f4 is present.

    Additional fields (f7.f2, f7.f6, f7.f8) are informational and ignored.
    """
    fd = _field_dict(body)
    f7 = fd.get(7)
    if not isinstance(f7, bytes):
        return None

    # Walk nested fields in f7
    sf = _field_dict(f7)
    stats: dict = {}

    model_bytes = sf.get(9)
    if isinstance(model_bytes, bytes):
        stats["model"] = _try_decode_utf8(model_bytes) or ""

    # ── input_tokens: f7.f4 (old API) or f7.f3 (new API) ──────────────────
    input_f4 = sf.get(4)
    input_f3 = sf.get(3)

    if isinstance(input_f4, int):
        # Old API: f7.f4 is the authoritative input_tokens
        stats["input_tokens"] = input_f4
        # If f7.f3 is also present, it was a cache-token field in the old API
        if isinstance(input_f3, int):
            stats["cache_creation_input_tokens"] = input_f3
    elif isinstance(input_f3, int):
        # New API: f7.f4 absent, input_tokens moved to f7.f3
        stats["input_tokens"] = input_f3

    # ── output_tokens: f7.f5 (both old and new API) ──────────────────────
    output_tokens = sf.get(5)
    if isinstance(output_tokens, int):
        stats["output_tokens"] = output_tokens

    msg_id_bytes = sf.get(7)
    if isinstance(msg_id_bytes, bytes):
        stats["msg_id"] = _try_decode_utf8(msg_id_bytes) or ""

    return stats if stats else None
