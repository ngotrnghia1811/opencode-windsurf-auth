#!/usr/bin/env python3
"""
decode_response.py — decode a raw GetChatMessage Connect-RPC response body
into newline-delimited JSON (NDJSON) of thinking/answer/finish events.

Usage:
  python3 decode_response.py <response.bin>

Supports both thinking models (claude-sonnet-4-6-thinking) and non-thinking
models (claude-sonnet-4-6). Auto-detects model type from the first content
delta (f9 = reasoning, f3 = answer).
"""

import json
import sys
import connect_decode as cd


def decode_response(data: bytes):
    """
    Generator yielding event dicts.

    Phase tracking:
      - "thinking": emitting f9 reasoning deltas (thinking model)
      - "answer":   emitting f3 answer deltas (non-thinking, or thinking post-sig)

    Stats are accumulated from every stats-bearing frame (f7 block) and
    emitted once at the stop frame (f5==4). This handles providers that
    split token counts across multiple frames or place them only in
    early metadata frames.
    """
    phase = "thinking"  # default assumption; auto-corrected for non-thinking
    seen_reasoning = False  # set True once first f9 text appears
    accumulated_stats: dict = {}

    for _fidx, _flag, body in cd.decode_connect_stream(data):
        # Accumulate stats from any frame that has them (not just stop frame)
        fresh = cd.extract_stats(body)
        if fresh:
            accumulated_stats.update(fresh)

        # Check for Anthropic signature boundary (f10 base64 + f21="anthropic").
        # This flips a thinking model from reasoning → answer phase.
        if phase == "thinking" and cd.is_signature_frame(body):
            phase = "answer"
            continue

        # Extract both candidate text fields
        f9_txt = cd.extract_text(body, field_num=9)
        f3_txt = cd.extract_text(body, field_num=3)

        if phase == "thinking":
            if f9_txt:
                seen_reasoning = True
                yield {"type": "reasoning", "text": f9_txt}
            elif f3_txt and not seen_reasoning:
                # Non-thinking model — first content delta is answer text in f3
                phase = "answer"
                yield {"type": "text", "text": f3_txt}
        else:  # phase == "answer"
            if f3_txt:
                yield {"type": "text", "text": f3_txt}

        # Stop frame: emit finish event with all accumulated stats
        if cd.is_stop_frame(body):
            if accumulated_stats:
                yield {"type": "finish", **accumulated_stats}
            accumulated_stats = {}


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <response.bin>", file=sys.stderr)
        sys.exit(1)

    data = open(sys.argv[1], "rb").read()
    for event in decode_response(data):
        print(json.dumps(event, ensure_ascii=False))


if __name__ == "__main__":
    main()
