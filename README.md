# realtime-chat

[![CI](https://github.com/beni001994/realtime-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/beni001994/realtime-chat/actions/workflows/ci.yml)

A small real-time chat server written in TypeScript on top of [`ws`](https://github.com/websockets/ws). It supports rooms, nicknames, join/leave events, bounded per-room history, per-connection rate limiting, message size limits, zod-validated input, heartbeat-based dead connection detection and graceful shutdown. The same process serves a plain HTML/JS browser client.

## Run it

Requires Node.js >= 22.

```bash
npm install
npm run dev          # tsx watch, http://127.0.0.1:3000
# or
npm run build && npm start
```

Open `http://127.0.0.1:3000` in two browser tabs, pick a nickname and chat.

Environment variables: `PORT` (default `3000`, `0` for ephemeral) and `HOST` (default `127.0.0.1`). `SIGTERM`/`SIGINT` trigger a graceful shutdown on POSIX systems.

```bash
npm run typecheck
npm test
```

## Protocol

All frames are JSON text frames over a single WebSocket. Binary frames are rejected with an `INVALID_MESSAGE` error. A connection is in at most one room at a time.

### Client to server

| `type`    | Fields                                  | Notes |
|-----------|-----------------------------------------|-------|
| `join`    | `room`, `nick`                          | Both 1-32 / 1-24 chars of `A-Za-z0-9_-`. Nicks are unique per room, compared case-insensitively. |
| `message` | `text`                                  | Trimmed, 1-500 characters. Must be in a room. |
| `leave`   | none                                    | Leave the current room; the connection stays open. |
| `ping`    | none                                    | Application-level ping; answered with `pong`. |

### Server to client

| `type`        | Fields                              | Sent to / when |
|---------------|-------------------------------------|----------------|
| `joined`      | `room`, `nick`, `users[]`, `history[]` | The joiner, after a successful `join`. `history` is the room's last N messages (`{nick, text, ts}`), oldest first. |
| `user_joined` | `room`, `nick`                      | Other members of the room when someone joins. |
| `message`     | `room`, `nick`, `text`, `ts`        | Every member of the room, including the sender. `ts` is server time in ms since epoch. |
| `user_left`   | `room`, `nick`                      | Remaining members when someone leaves or disconnects. |
| `left`        | `room`                              | The leaver, after a successful `leave`. |
| `pong`        | none                                | Reply to `ping`. |
| `error`       | `code`, `message`                   | The offending connection only. The connection stays open. |

### Error codes

| `code`            | Meaning |
|-------------------|---------|
| `INVALID_JSON`    | Frame was not parseable JSON. |
| `INVALID_MESSAGE` | Valid JSON that failed schema validation (unknown type, bad nick/room, empty or too long text, binary frame). |
| `NOT_IN_ROOM`     | `message` or `leave` while not in a room. |
| `ALREADY_IN_ROOM` | `join` while already in a room. |
| `NICK_TAKEN`      | Nickname already used in that room. |
| `RATE_LIMITED`    | Per-connection token bucket is empty; the frame was dropped. |

### Limits and connection-level behaviour

| Behaviour | Default | Details |
|-----------|---------|---------|
| Message size | 2048 bytes per frame | Enforced by `ws` `maxPayload`; an oversized frame closes the socket with code `1009`. Text is additionally capped at 500 characters by validation. |
| Rate limit | burst 5, 2 messages/s sustained | Token bucket per connection, applied to every frame. Excess frames get `RATE_LIMITED`. |
| History | 50 messages per room | Oldest entries are discarded. |
| Heartbeat | ping every 30 s | A connection that has not answered the previous protocol-level ping with a pong by the next tick is terminated. Browsers answer pings automatically. |
| Shutdown | 2 s grace | Clients get close code `1001`; stragglers are terminated after the grace period. |

All defaults are options of `createChatServer()` (see `src/server.ts`).

## Architecture

```
src/
  protocol.ts     zod schemas, parseClientMessage(), server message types   (pure)
  rooms.ts        RoomManager: membership, nick uniqueness, bounded history (pure)
  rateLimiter.ts  token bucket with an injectable clock                     (pure)
  server.ts       http + ws wiring, heartbeat, shutdown, static files
  main.ts         env config and signal handling
public/           index.html + client.js (no build step, no dependencies)
test/             unit tests for the pure modules, integration tests for the server
```

The pure modules know nothing about sockets. `RoomManager` works on opaque connection ids and returns who should be notified; `server.ts` is the only place that touches `ws`. The clock is injected into the rate limiter and the server, so time-dependent logic is tested without sleeping.

The integration tests (`test/server.test.ts`) start the real server on an ephemeral port and connect real `ws` clients to exercise join/leave events, broadcasting, room isolation, history, validation errors, rate limiting, oversized frames, heartbeat dropping and graceful shutdown.

## Limitations

This is a portfolio project, not a production chat service.

- **No authentication or authorization.** Anyone can connect and claim any nickname that is free in a room; nicknames are not reserved or verified.
- **In-memory only.** Rooms and history vanish on restart, and a room's history is deleted when its last member leaves. There is no persistence.
- **Single process.** No horizontal scaling or pub/sub between instances.
- **No TLS.** Put it behind a reverse proxy for `wss://`. No Origin checking is implemented.
- **Rate limiting is per connection, not per IP**, so opening many connections bypasses it. There is no cap on connections.
- **Rate-limited frames are dropped, not penalised**; clients are never disconnected for spamming.
- No typing indicators, private messages, message editing or delivery acknowledgements; the browser client does not resume state after a reconnect beyond re-joining manually.
- Graceful shutdown on signals is implemented via `SIGINT`/`SIGTERM` handlers, which Node on Windows does not deliver reliably; the shutdown logic itself is covered by tests through `close()`.

## License

MIT
