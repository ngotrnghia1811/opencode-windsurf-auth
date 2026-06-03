// proto.ts — minimal protobuf wire encode helpers + Connect framing
//
// Mirror of the Python research decoders:
//   opencode-windsurf-auth/research/decode_request.py
//   opencode-windsurf-auth/research/connect_decode.py
//
// Wire types: 0=varint, 1=fixed64, 2=length-delimited, 5=fixed32
// tag = (field_number << 3) | wire_type

// ---------------------------------------------------------------------------
// Varint encode
// ---------------------------------------------------------------------------

export function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = []
  let v = value
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  bytes.push(v & 0x7f)
  return new Uint8Array(bytes)
}

export function encodeVarintField(field: number, value: number): Uint8Array {
  const tag = encodeVarint((field << 3) | 0) // wire type 0
  const val = encodeVarint(value)
  return concat(tag, val)
}

export function encodeFixed64Field(field: number, value: number): Uint8Array {
  const tag = encodeVarint((field << 3) | 1) // wire type 1
  const buf = new ArrayBuffer(8)
  const view = new DataView(buf)
  view.setFloat64(0, value, true) // little-endian
  return concat(tag, new Uint8Array(buf))
}

export function encodeBytesField(field: number, bytes: Uint8Array): Uint8Array {
  const tag = encodeVarint((field << 3) | 2) // wire type 2
  const len = encodeVarint(bytes.byteLength)
  return concat(tag, len, bytes)
}

export function encodeStringField(field: number, str: string): Uint8Array {
  return encodeBytesField(field, new TextEncoder().encode(str))
}

// encodeMessageField wraps encoded sub-message bytes into a length-delimited field
export function encodeMessageField(field: number, msg: Uint8Array): Uint8Array {
  return encodeBytesField(field, msg)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Connect framing
// ---------------------------------------------------------------------------

/**
 * Wrap a protobuf body into a Connect unary request frame:
 * 1 flag byte (0x00) + 4-byte big-endian length + body.
 */
export function encodeConnectFrame(body: Uint8Array): Uint8Array {
  const header = new Uint8Array(5)
  header[0] = 0x00 // no flags
  const len = body.byteLength
  header[1] = (len >>> 24) & 0xff
  header[2] = (len >>> 16) & 0xff
  header[3] = (len >>> 8) & 0xff
  header[4] = len & 0xff
  return concat(header, body)
}

// Response frame flags
export const CONNECT_FLAG_EOS = 0x02

/**
 * Stream parser: yields { flag, body } for each Connect frame in the
 * accumulated buffer. Call repeatedly as bytes arrive. Call with empty
 * accumulator + new chunk; returns { frames, remainder } for incremental use.
 */
export function parseConnectFrames(
  buf: Uint8Array,
): Array<{ flag: number; body: Uint8Array }> {
  const frames: Array<{ flag: number; body: Uint8Array }> = []
  let i = 0
  while (i + 5 <= buf.byteLength) {
    const flag = buf[i]
    const bodyLen =
      ((buf[i + 1] << 24) |
        (buf[i + 2] << 16) |
        (buf[i + 3] << 8) |
        buf[i + 4]) >>>
      0
    if (i + 5 + bodyLen > buf.byteLength) break // not enough data yet
    const body = buf.slice(i + 5, i + 5 + bodyLen)
    frames.push({ flag, body })
    i += 5 + bodyLen
  }
  return frames
}
