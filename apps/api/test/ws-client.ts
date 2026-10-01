import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

/**
 * A deliberately independent, minimal RFC 6455 client for the agent channel. It shares no code with
 * the server implementation, so a framing bug in the server cannot be hidden by the same bug here.
 */
export interface AgentSocket {
  send(obj: unknown): void;
  /** Next parsed JSON message, or a rejection if none arrives within `timeoutMs`. */
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Raw close code the server sent, if any. */
  closeCode(): number | null;
  close(): void;
  readonly handshakeStatus: number;
  readonly handshakeHeaders: Record<string, string>;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function maskFrame(opcode: number, payload: Buffer): Buffer {
  const key = randomBytes(4);
  const header: number[] = [0x80 | opcode];
  if (payload.length < 126) header.push(0x80 | payload.length);
  else if (payload.length < 65_536) header.push(0x80 | 126, payload.length >> 8, payload.length & 0xff);
  else {
    header.push(0x80 | 127, 0, 0, 0, 0);
    header.push(
      (payload.length / 2 ** 24) & 0xff,
      (payload.length >> 16) & 0xff,
      (payload.length >> 8) & 0xff,
      payload.length & 0xff,
    );
  }
  header.push(...key);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] = (masked[i] as number) ^ (key[i % 4] as number);
  return Buffer.concat([Buffer.from(header), masked]);
}

/** Unmasked server frame; the server must never mask. Throws if it does. */
function readFrame(buf: Buffer): { frame: { opcode: number; payload: Buffer } | null; rest: Buffer } {
  if (buf.length < 2) return { frame: null, rest: buf };
  const opcode = (buf[0] as number) & 0x0f;
  const masked = ((buf[1] as number) & 0x80) !== 0;
  if (masked) throw new Error("server frame must not be masked");
  let len = (buf[1] as number) & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return { frame: null, rest: buf };
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return { frame: null, rest: buf };
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  if (buf.length < off + len) return { frame: null, rest: buf };
  return {
    frame: { opcode, payload: Buffer.from(buf.subarray(off, off + len)) },
    rest: Buffer.from(buf.subarray(off + len)),
  };
}

export async function connectAgent(port: number, token: string, path = "/v1/agent/ws"): Promise<AgentSocket> {
  const key = randomBytes(16).toString("base64");
  const socket = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      `Authorization: Agent ${token}`,
      "",
      "",
    ].join("\r\n"),
  );

  let buf: Buffer = Buffer.alloc(0);
  const expect = createHash("sha1").update(`${key}${GUID}`).digest("base64");
  const messages: Record<string, unknown>[] = [];
  const waiters: ((m: Record<string, unknown>) => void)[] = [];
  let closed = false;
  let code: number | null = null;
  let handshakeStatus = 0;
  let handshakeHeaders: Record<string, string> = {};
  let headerDone = false;
  let handshakeResolve: (() => void) | undefined;
  const handshakeDone = new Promise<void>((resolve) => {
    handshakeResolve = resolve;
  });

  const pump = () => {
    while (true) {
      const { frame, rest } = readFrame(buf);
      if (!frame) return;
      buf = rest;
      if (frame.opcode === 0x1) {
        const msg = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
        const w = waiters.shift();
        if (w) w(msg);
        else messages.push(msg);
      } else if (frame.opcode === 0x8) {
        code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        closed = true;
      } else if (frame.opcode === 0x9) {
        socket.write(maskFrame(0xa, frame.payload));
      }
    }
  };

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!headerDone) {
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = buf.subarray(0, end).toString("utf8");
      buf = buf.subarray(end + 4);
      headerDone = true;
      const [first, ...lines] = head.split("\r\n");
      handshakeStatus = Number((first ?? "").split(" ")[1] ?? 0);
      for (const line of lines) {
        const i = line.indexOf(":");
        if (i > 0) handshakeHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      if (handshakeStatus !== 101) {
        closed = true;
        handshakeResolve?.();
        return;
      }
      if (handshakeHeaders["sec-websocket-accept"] !== expect) {
        throw new Error("bad Sec-WebSocket-Accept");
      }
      handshakeResolve?.();
    }
    pump();
  });
  socket.on("close", () => {
    closed = true;
    if (handshakeResolve && !headerDone) handshakeResolve();
  });

  // The handshake must be awaited: reading status/headers before the response arrives would report 0.
  await handshakeDone;

  return {
    get handshakeStatus() {
      return handshakeStatus;
    },
    get handshakeHeaders() {
      return handshakeHeaders;
    },
    send(obj) {
      socket.write(maskFrame(0x1, Buffer.from(JSON.stringify(obj), "utf8")));
    },
    next(timeoutMs = 3000) {
      const queued = messages.shift();
      if (queued) return Promise.resolve(queued);
      if (closed) return Promise.reject(new Error("socket closed before a message arrived"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`no message within ${timeoutMs} ms`));
        }, timeoutMs);
        waiters.push((m) => {
          clearTimeout(timer);
          resolve(m);
        });
      });
    },
    closeCode: () => code,
    close() {
      socket.destroy();
    },
  };
}
