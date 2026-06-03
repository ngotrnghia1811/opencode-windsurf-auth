"""Parse Connect streaming framing + dump proto field structure of each frame."""
import struct, sys

def parse_varint(b, i):
    shift = 0; result = 0
    while True:
        byte = b[i]; i += 1
        result |= (byte & 0x7F) << shift
        if not (byte & 0x80): break
        shift += 7
    return result, i

def dump_proto(b, indent=0, maxdepth=4):
    i = 0; pad = "  " * indent
    out = []
    while i < len(b):
        try:
            tag, i = parse_varint(b, i)
        except IndexError:
            break
        field = tag >> 3; wire = tag & 7
        if wire == 2:
            ln, i = parse_varint(b, i)
            val = b[i:i+ln]; i += ln
            # try to decode as nested message vs string
            is_text = all(32 <= c < 127 or c in (9,10,13) for c in val[:60]) if val else True
            if is_text and val:
                txt = val[:80].decode('utf-8','replace')
                out.append(f"{pad}f{field} (str/{ln}): {txt!r}")
            elif indent < maxdepth and val and val[0] not in (0xff,):
                out.append(f"{pad}f{field} (msg/{ln}):")
                out.extend(dump_proto(val, indent+1, maxdepth))
            else:
                out.append(f"{pad}f{field} (bytes/{ln}): {val[:32].hex()}")
        elif wire == 0:
            v, i = parse_varint(b, i)
            out.append(f"{pad}f{field} (varint): {v}")
        elif wire == 5:
            v = struct.unpack('<I', b[i:i+4])[0]; i += 4
            out.append(f"{pad}f{field} (i32): {v}")
        elif wire == 1:
            v = struct.unpack('<Q', b[i:i+8])[0]; i += 8
            out.append(f"{pad}f{field} (i64): {v}")
        else:
            out.append(f"{pad}!unknown wire {wire} at field {field}")
            break
    return out

data = open(sys.argv[1],'rb').read()
print(f"total {len(data)} bytes")
i = 0; frame = 0
while i + 5 <= len(data):
    flag = data[i]
    ln = struct.unpack('>I', data[i+1:i+5])[0]
    print(f"\n### FRAME {frame} flag=0x{flag:02x} len={ln}")
    body = data[i+5:i+5+ln]
    i += 5 + ln; frame += 1
    if flag & 0x02:  # end-of-stream frame (JSON trailers)
        print("  [EOS trailer]:", body[:300].decode('utf-8','replace'))
        continue
    for line in dump_proto(body):
        print(line)
