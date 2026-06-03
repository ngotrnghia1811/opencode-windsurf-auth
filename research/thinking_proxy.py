"""
thinking_proxy.py — mitmproxy addon that intercepts Windsurf/Devin
GetChatMessage responses, decodes the Connect-RPC protobuf stream,
and appends thinking/answer/finish events as NDJSON to a sink file.

Usage:
  mitmdump -q -p 8080 -s thinking_proxy.py

Sink file: $WINDSURF_THINKING_SINK, default /tmp/windsurf_thinking_stream.jsonl

This addon is transparent — it observes and decodes only; traffic passes
through unmodified.
"""

import os
import sys

# Ensure the research dir is on sys.path so we can import connect_decode
_this_dir = os.path.dirname(os.path.abspath(__file__))
if _this_dir not in sys.path:
    sys.path.insert(0, _this_dir)

import connect_decode as cd
from mitmproxy import http


# ---------------------------------------------------------------------------
# Sink file path (from env, with default)
# ---------------------------------------------------------------------------
SINK_PATH = os.environ.get("WINDSURF_THINKING_SINK", "/tmp/windsurf_thinking_stream.jsonl")


# ---------------------------------------------------------------------------
# Decode logic (inlined for zero-latency append-per-event)
# ---------------------------------------------------------------------------

def _decode_and_format(body_bytes: bytes) -> list[str]:
    """
    Decode a full GetChatMessage response body and return a list of
    JSON-string lines (one per event) ready to append.

    Uses the same state machine as decode_response.main().
    Stats are accumulated across frames and emitted at the stop frame.
    """
    import json

    phase = "thinking"
    seen_reasoning = False
    accumulated_stats: dict = {}
    lines: list[str] = []

    for _fidx, _flag, body in cd.decode_connect_stream(body_bytes):
        # Accumulate stats from any frame
        fresh = cd.extract_stats(body)
        if fresh:
            accumulated_stats.update(fresh)

        if phase == "thinking" and cd.is_signature_frame(body):
            phase = "answer"
            continue

        f9 = cd.extract_text(body, field_num=9)
        f3 = cd.extract_text(body, field_num=3)

        if phase == "thinking":
            if f9:
                seen_reasoning = True
                lines.append(json.dumps({"type": "reasoning", "text": f9}, ensure_ascii=False))
            elif f3 and not seen_reasoning:
                phase = "answer"
                lines.append(json.dumps({"type": "text", "text": f3}, ensure_ascii=False))
        else:
            if f3:
                lines.append(json.dumps({"type": "text", "text": f3}, ensure_ascii=False))

        if cd.is_stop_frame(body):
            if accumulated_stats:
                lines.append(json.dumps({"type": "finish", **accumulated_stats}, ensure_ascii=False))
            accumulated_stats = {}

    return lines


# ---------------------------------------------------------------------------
# mitmproxy addon hooks
# ---------------------------------------------------------------------------

class ThinkingProxy:
    """
    Transparent passthrough proxy that decodes GetChatMessage responses
    and writes the thinking/answer stream to the sink file.
    """

    def response(self, flow: http.HTTPFlow) -> None:
        """Called when the full response is available."""
        # Only intercept GetChatMessage RPC calls
        if not flow.request.path.endswith("/GetChatMessage"):
            return

        if flow.response is None or not flow.response.raw_content:
            return

        # Decode the Connect stream
        lines = _decode_and_format(flow.response.raw_content)
        if not lines:
            return

        # Append to sink file atomically (line-at-a-time for crash safety)
        try:
            with open(SINK_PATH, "a") as f:
                for line in lines:
                    f.write(line + "\n")
        except OSError as e:
            # Don't crash the proxy on file I/O errors
            print(f"[thinking_proxy] WARNING: cannot write to {SINK_PATH}: {e}", file=sys.stderr)


# mitmproxy expects the addon instances in a list named `addons`
addons = [ThinkingProxy()]
