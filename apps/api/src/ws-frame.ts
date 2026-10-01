import { createHash, randomBytes } from "node:crypto";

/**
 * Minimal RFC 6455 framing. The project deliberately avoids a WebSocket dependency for the agent
 * channel: the surface we need is small (text frames, ping/pong, close, fragmentation) and keeping it
 * in-tree means one less supply-chain edge on a component that terminates connections from the field.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Motion thumbnails are at most 20 KB; anything near this bound is a client bug or an attack. */
export const MAX_FRAME_BYTES = 512 * 1024;

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

export function acceptKey(secWebSocketKey: string): string {
  return createHash("sha1").update(`${secWebSocketKey}${GUID}`).digest("base64");
}

/** Server-to-client frames are never masked (RFC 6455 section 5.1). */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export const encodeText = (text: string): Buffer => encodeFrame(OPCODE.text, Buffer.from(text, "utf8"));
export const encodePong = (payload: Buffer): Buffer => encodeFrame(OPCODE.pong, payload);
export function encodeClose(code: number, reason = ""): Buffer {
  const reasonBuf = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  return encodeFrame(OPCODE.close, payload);
}

export type DecodedFrame =
  | { kind: "text"; text: string }
  | { kind: "ping"; payload: Buffer }
  | { kind: "pong"; payload: Buffer }
  | { kind: "close"; code: number }
  | { kind: "protocol-error"; reason: string; closeCode: number };

/**
 * Incremental decoder with fragmentation reassembly. Client frames must be masked; an unmasked frame
 * is a protocol violation (RFC 6455 section 5.1), not something to quietly tolerate.
 */
export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode: number | null = null;

  push(chunk: Buffer): DecodedFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: DecodedFrame[] = [];
    for (;;) {
      const decoded = this.readOne();
      if (!decoded) break;
      out.push(decoded);
      if (decoded.kind === "protocol-error") break;
    }
    return out;
  }

  private readOne(): DecodedFrame | null {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = ((buf[0] as number) & 0x80) !== 0;
    const opcode = (buf[0] as number) & 0x0f;
    const masked = ((buf[1] as number) & 0x80) !== 0;
    let len = (buf[1] as number) & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME_BYTES)) return this.fail("frame too large", 1009);
      len = Number(big);
      offset = 10;
    }
    if (len > MAX_FRAME_BYTES) return this.fail("frame too large", 1009);
    if (!masked) return this.fail("client frames must be masked", 1002);
    if (buf.length < offset + 4 + len) return null;
    const maskKey = buf.subarray(offset, offset + 4);
    const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len));
    this.buffer = buf.subarray(offset + 4 + len);
    for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (maskKey[i % 4] as number);

    const isControl = (opcode & 0x8) !== 0;
    if (isControl) {
      if (!fin || payload.length > 125) return this.fail("invalid control frame", 1002);
      if (opcode === OPCODE.ping) return { kind: "ping", payload };
      if (opcode === OPCODE.pong) return { kind: "pong", payload };
      if (opcode === OPCODE.close) {
        return { kind: "close", code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005 };
      }
      return this.fail("unknown control opcode", 1002);
    }

    if (opcode === OPCODE.continuation) {
      if (this.fragmentOpcode === null) return this.fail("continuation without a start frame", 1002);
      this.fragments.push(payload);
    } else if (opcode === OPCODE.text || opcode === OPCODE.binary) {
      if (this.fragmentOpcode !== null) return this.fail("nested data frame", 1002);
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
    } else {
      return this.fail("unknown data opcode", 1002);
    }

    if (!fin) return null;
    const full = Buffer.concat(this.fragments);
    const startOpcode = this.fragmentOpcode;
    this.fragments = [];
    this.fragmentOpcode = null;
    if (startOpcode !== OPCODE.text) return this.fail("binary messages are not accepted", 1003);
    return { kind: "text", text: full.toString("utf8") };
  }

  private fail(reason: string, closeCode: number): DecodedFrame {
    this.buffer = Buffer.alloc(0);
    return { kind: "protocol-error", reason, closeCode };
  }
}

/** Nonce for the `Sec-WebSocket-Key` header; exported so tests can drive the same handshake path. */
export const newHandshakeKey = (): string => randomBytes(16).toString("base64");
