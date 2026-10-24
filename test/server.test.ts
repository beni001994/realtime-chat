import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createChatServer, type ChatServer, type ChatServerOptions } from "../src/server.js";

type Msg = Record<string, any>;

class TestClient {
  readonly received: Msg[] = [];
  closeCode: number | undefined;
  readonly closed: Promise<number>;
  private waiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      this.received.push(JSON.parse(data.toString()));
      this.waiters.splice(0).forEach((w) => w());
    });
    this.closed = new Promise((resolve) =>
      ws.on("close", (code) => {
        this.closeCode = code;
        resolve(code);
      }),
    );
  }

  static async connect(port: number, options?: WebSocket.ClientOptions): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, options);
    const client = new TestClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return client;
  }

  send(msg: unknown): void {
    this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  /** Resolve with the next not-yet-consumed message matching the predicate. */
  async next(match: (m: Msg) => boolean = () => true, timeoutMs = 2000): Promise<Msg> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.received.findIndex(match);
      if (idx !== -1) return this.received.splice(idx, 1)[0];
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out; pending: ${JSON.stringify(this.received)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  nextOfType(type: string): Promise<Msg> {
    return this.next((m) => m.type === type);
  }

  async join(room: string, nick: string): Promise<Msg> {
    this.send({ type: "join", room, nick });
    return this.nextOfType("joined");
  }

  close(): void {
    this.ws.close();
  }
}

let server: ChatServer | undefined;
const clients: TestClient[] = [];

async function start(opts: Partial<ChatServerOptions> = {}) {
  server = createChatServer(opts);
  const port = await server.listen(0);
  const connect = async (options?: WebSocket.ClientOptions) => {
    const c = await TestClient.connect(port, options);
    clients.push(c);
    return c;
  };
  return { port, connect };
}

afterEach(async () => {
  clients.splice(0).forEach((c) => c.ws.terminate());
  await server?.close();
  server = undefined;
});

describe("HTTP", () => {
  it("serves the browser client and a health check", async () => {
    const { port } = await start();
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("<title>");
    const js = await fetch(`http://127.0.0.1:${port}/client.js`);
    expect(js.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/../package.json`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
  });
});

describe("rooms and messaging", () => {
  it("joins, announces joiners and broadcasts messages within a room", async () => {
    const { connect } = await start({ now: () => 1000 });
    const ann = await connect();
    const bob = await connect();

    expect(await ann.join("general", "ann")).toMatchObject({ room: "general", nick: "ann", users: ["ann"], history: [] });
    expect(await bob.join("general", "bob")).toMatchObject({ users: ["ann", "bob"] });
    expect(await ann.nextOfType("user_joined")).toEqual({ type: "user_joined", room: "general", nick: "bob" });

    bob.send({ type: "message", text: "hello" });
    const expected = { type: "message", room: "general", nick: "bob", text: "hello", ts: 1000 };
    expect(await ann.nextOfType("message")).toEqual(expected);
    expect(await bob.nextOfType("message")).toEqual(expected);
  });

  it("isolates rooms from each other", async () => {
    const { connect } = await start();
    const ann = await connect();
    const bob = await connect();
    await ann.join("a", "ann");
    await bob.join("b", "bob");
    ann.send({ type: "message", text: "only in a" });
    await ann.nextOfType("message");
    bob.send({ type: "ping" });
    await bob.nextOfType("pong");
    expect(bob.received.filter((m) => m.type === "message")).toEqual([]);
  });

  it("replays bounded history to late joiners", async () => {
    const { connect } = await start({ historyLimit: 3, rateLimit: { capacity: 100, refillPerSecond: 100 } });
    const ann = await connect();
    await ann.join("r", "ann");
    for (let i = 1; i <= 5; i++) ann.send({ type: "message", text: `m${i}` });
    for (let i = 0; i < 5; i++) await ann.nextOfType("message");

    const bob = await connect();
    const joined = await bob.join("r", "bob");
    expect(joined.history.map((h: Msg) => h.text)).toEqual(["m3", "m4", "m5"]);
  });

  it("rejects duplicate nicknames in a room", async () => {
    const { connect } = await start();
    const ann = await connect();
    const imposter = await connect();
    await ann.join("r", "ann");
    imposter.send({ type: "join", room: "r", nick: "ANN" });
    expect(await imposter.nextOfType("error")).toMatchObject({ code: "NICK_TAKEN" });
  });

  it("rejects messages before joining and double joins", async () => {
    const { connect } = await start();
    const c = await connect();
    c.send({ type: "message", text: "hi" });
    expect(await c.nextOfType("error")).toMatchObject({ code: "NOT_IN_ROOM" });
    await c.join("r", "ann");
    c.send({ type: "join", room: "other", nick: "ann" });
    expect(await c.nextOfType("error")).toMatchObject({ code: "ALREADY_IN_ROOM" });
  });

  it("notifies others on explicit leave and on disconnect, and allows rejoining", async () => {
    const { connect } = await start();
    const ann = await connect();
    const bob = await connect();
    const cy = await connect();
    await ann.join("r", "ann");
    await bob.join("r", "bob");
    await cy.join("r", "cy");
    await ann.nextOfType("user_joined");
    await ann.nextOfType("user_joined");

    bob.send({ type: "leave" });
    expect(await bob.nextOfType("left")).toEqual({ type: "left", room: "r" });
    expect(await ann.nextOfType("user_left")).toEqual({ type: "user_left", room: "r", nick: "bob" });

    cy.close();
    expect(await ann.nextOfType("user_left")).toMatchObject({ nick: "cy" });

    expect(await bob.join("r", "bob")).toMatchObject({ users: ["ann", "bob"] });
  });
});

describe("validation and limits", () => {
  it("returns structured errors for bad input without dropping the connection", async () => {
    const { connect } = await start({ rateLimit: { capacity: 100, refillPerSecond: 100 } });
    const c = await connect();
    c.send("{not json");
    expect(await c.nextOfType("error")).toMatchObject({ code: "INVALID_JSON" });
    c.send({ type: "teleport" });
    expect(await c.nextOfType("error")).toMatchObject({ code: "INVALID_MESSAGE" });
    c.send({ type: "join", room: "bad room!", nick: "ann" });
    expect(await c.nextOfType("error")).toMatchObject({ code: "INVALID_MESSAGE" });
    c.ws.send(Buffer.from([1, 2, 3]));
    expect(await c.nextOfType("error")).toMatchObject({ code: "INVALID_MESSAGE" });
    c.send({ type: "ping" });
    expect(await c.nextOfType("pong")).toEqual({ type: "pong" });
  });

  it("rejects message text over the length limit", async () => {
    const { connect } = await start();
    const c = await connect();
    await c.join("r", "ann");
    c.send({ type: "message", text: "x".repeat(501) });
    expect(await c.nextOfType("error")).toMatchObject({ code: "INVALID_MESSAGE" });
  });

  it("closes the connection with 1009 when a frame exceeds maxPayloadBytes", async () => {
    const { connect } = await start({ maxPayloadBytes: 256 });
    const c = await connect();
    c.send("x".repeat(1000));
    expect(await c.closed).toBe(1009);
  });

  it("rate limits per connection without affecting other connections", async () => {
    const { connect } = await start({ rateLimit: { capacity: 3, refillPerSecond: 0.01 } });
    const spammer = await connect();
    const bystander = await connect();
    for (let i = 0; i < 6; i++) spammer.send({ type: "ping" });
    expect((await spammer.next((m) => m.type === "error")).code).toBe("RATE_LIMITED");
    await spammer.nextOfType("pong");
    expect(spammer.received.filter((m) => m.type === "pong").length).toBe(2);

    bystander.send({ type: "ping" });
    expect(await bystander.nextOfType("pong")).toEqual({ type: "pong" });
  });
});

describe("heartbeat and shutdown", () => {
  it("drops connections that stop answering pings but keeps healthy ones", async () => {
    const { connect } = await start({ heartbeatIntervalMs: 50 });
    const dead = await connect({ autoPong: false });
    const healthy = await connect();
    await dead.join("r", "dead");
    await healthy.join("r", "healthy");
    await dead.closed;
    expect(healthy.ws.readyState).toBe(WebSocket.OPEN);
    expect(await healthy.nextOfType("user_left")).toMatchObject({ nick: "dead" });
  });

  it("shuts down gracefully, closing clients with 1001", async () => {
    const { port, connect } = await start();
    const a = await connect();
    const b = await connect();
    await a.join("r", "a");
    await b.join("r", "b");
    const stopped = server!.close();
    expect(await a.closed).toBe(1001);
    expect(await b.closed).toBe(1001);
    await stopped;
    await expect(TestClient.connect(port, {})).rejects.toBeDefined();
  });

  it("force-terminates clients that ignore the close handshake after the grace period", async () => {
    const { connect } = await start({ shutdownGraceMs: 100 });
    const stuck = await connect({ autoPong: false });
    // Ignore the server's close frame by never replying: pause the underlying socket.
    (stuck.ws as any)._socket.pause();
    const started = Date.now();
    await server!.close();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
