"""Read thinking flow, dump GetChatMessage response."""
from mitmproxy import io, http
import sys
with open("/tmp/windsurf_thinking.flow","rb") as f:
    idx=0
    for flow in io.FlowReader(f).stream():
        if not isinstance(flow, http.HTTPFlow): continue
        if "GetChatMessage" not in flow.request.pretty_url: continue
        if flow.response and flow.response.raw_content:
            open(f"/tmp/think_resp_{idx}.bin","wb").write(flow.response.raw_content)
            print(f"resp {idx}: {len(flow.response.raw_content)} bytes", file=sys.stderr)
        idx+=1
