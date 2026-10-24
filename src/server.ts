import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { parseClientMessage, serialize, type ServerMessage } from "./protocol.js";
import { RateLimiter } from "./rateLimiter.js";
import { RoomManager } from "./rooms.js";

export interface ChatServerOptions {
  /** Messages kept per room and replayed on join. */
  historyLimit: number;
  /** Max accepted frame size in bytes; larger frames close the socket with 1009. */
  maxPayloadBytes: number;
  /** Per-connection token bucket: burst size and sustained messages/second. */
  rateLimit: { capacity: number; refillPerSecond: number };
  /** How often to ping clients; a client that misses one full interval is terminated. */
  heartbeatIntervalMs: number;
  /** On shutdown, how long to wait for clients to close before terminating them. */
  shutdownGraceMs: number;
  /** Clock used for message timestamps and rate limiting. */
  now: () => number;
}

export const DEFAULT_OPTIONS: ChatServerOptions = {
  historyLimit: 50,
  maxPayloadBytes: 2048,
  rateLimit: { capacity: 5, refillPerSecond: 2 },
  heartbeatIntervalMs: 30_000,
  shutdownGraceMs: 2_000,
  now: Date.now,
};

const PUBLIC_DIR = new URL("../public/", import.meta.url);
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/client.js": { file: "client.js", type: "text/javascript; charset=utf-8" },
};

interface Connection {
  id: string;
  socket: WebSocket;
  limiter: RateLimiter;
  alive: boolean;
}

export interface ChatServer {
  /** Start listening. Pass port 0 for an ephemeral port; resolves with the bound port. */
  listen(port: number, host?: string): Promise<number>;
  /** Graceful shutdown: stop accepting, close sockets with 1001, wait, then force-close. */
  close(): Promise<void>;
}

export function createChatServer(overrides: Partial<ChatServerOptions> = {}): ChatServer {
  const opts: ChatServerOptions = { ...DEFAULT_OPTIONS, ...overrides };
  const rooms = new RoomManager(opts.historyLimit);
  const connections = new Map<string, Connection>();
  let nextId = 1;
  let closing: Promise<void> | undefined;

  const http: Server = createServer((req, res) => {
    void handleHttp(req, res);
  });
  const wss = new WebSocketServer({ server: http, maxPayload: opts.maxPayloadBytes });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    const entry = req.method === "GET" ? STATIC_FILES[path] : undefined;
    if (!entry) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    try {
      const body = await readFile(fileURLToPath(new URL(entry.file, PUBLIC_DIR)));
      res.writeHead(200, { "content-type": entry.type, "cache-control": "no-cache" }).end(body);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" }).end("Failed to read file");
    }
  }

  function send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(serialize(message));
  }

  function sendTo(ids: string[], message: ServerMessage): void {
    const data = serialize(message);
    for (const id of ids) {
      const c = connections.get(id);
      if (c && c.socket.readyState === c.socket.OPEN) c.socket.send(data);
    }
  }

  function leaveRoom(conn: Connection): string | undefined {
    const result = rooms.leave(conn.id);
    if (!result) return undefined;
    sendTo(result.remaining, { type: "user_left", room: result.room, nick: result.nick });
    return result.room;
  }

  function handleFrame(conn: Connection, raw: RawData, isBinary: boolean): void {
    if (!conn.limiter.tryConsume()) {
      send(conn.socket, { type: "error", code: "RATE_LIMITED", message: "Slow down" });
      return;
    }
    if (isBinary) {
      send(conn.socket, { type: "error", code: "INVALID_MESSAGE", message: "Binary frames are not supported" });
      return;
    }
    const parsed = parseClientMessage(raw.toString());
    if (!parsed.ok) {
      send(conn.socket, { type: "error", code: parsed.code, message: parsed.message });
      return;
    }
    const msg = parsed.message;
    switch (msg.type) {
      case "ping":
        send(conn.socket, { type: "pong" });
        return;
      case "join": {
        const r = rooms.join(conn.id, msg.room, msg.nick);
        if (!r.ok) {
          const message =
            r.code === "NICK_TAKEN" ? "Nickname is already used in this room" : "Already in a room; leave first";
          send(conn.socket, { type: "error", code: r.code, message });
          return;
        }
        send(conn.socket, { type: "joined", room: r.room, nick: msg.nick, users: r.users, history: r.history });
        sendTo(r.others, { type: "user_joined", room: r.room, nick: msg.nick });
        return;
      }
      case "message": {
        const r = rooms.post(conn.id, msg.text, opts.now());
        if (!r.ok) {
          send(conn.socket, { type: "error", code: r.code, message: "Join a room first" });
          return;
        }
        sendTo(r.recipients, { type: "message", room: r.room, ...r.entry });
        return;
      }
      case "leave": {
        const room = leaveRoom(conn);
        if (room === undefined) {
          send(conn.socket, { type: "error", code: "NOT_IN_ROOM", message: "Not in a room" });
          return;
        }
        send(conn.socket, { type: "left", room });
        return;
      }
    }
  }

  wss.on("connection", (socket) => {
    const conn: Connection = {
      id: String(nextId++),
      socket,
      limiter: new RateLimiter(opts.rateLimit.capacity, opts.rateLimit.refillPerSecond, opts.now),
      alive: true,
    };
    connections.set(conn.id, conn);
    socket.on("pong", () => {
      conn.alive = true;
    });
    socket.on("message", (raw, isBinary) => handleFrame(conn, raw, isBinary));
    socket.on("close", () => {
      leaveRoom(conn);
      connections.delete(conn.id);
    });
    socket.on("error", () => socket.terminate());
  });

  // Heartbeat: any connection that did not answer the previous ping is dropped.
  const heartbeat = setInterval(() => {
    for (const conn of connections.values()) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      conn.socket.ping();
    }
  }, opts.heartbeatIntervalMs);
  heartbeat.unref();

  return {
    listen(port, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, host, () => {
          http.off("error", reject);
          resolve((http.address() as AddressInfo).port);
        });
      });
    },

    close() {
      closing ??= (async () => {
        clearInterval(heartbeat);
        // Stop accepting new HTTP/WebSocket connections first.
        const httpClosed = new Promise<void>((resolve) => http.close(() => resolve()));
        for (const conn of connections.values()) conn.socket.close(1001, "server shutting down");
        const deadline = Date.now() + opts.shutdownGraceMs;
        while (connections.size > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
        for (const conn of connections.values()) conn.socket.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        http.closeAllConnections();
        await httpClosed;
      })();
      return closing;
    },
  };
}
