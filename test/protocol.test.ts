import { describe, expect, it } from "vitest";
import { LIMITS, parseClientMessage } from "../src/protocol.js";

const parse = (v: unknown) => parseClientMessage(JSON.stringify(v));

describe("parseClientMessage", () => {
  it("accepts a valid join", () => {
    expect(parse({ type: "join", room: "general", nick: "ann_1" })).toEqual({
      ok: true,
      message: { type: "join", room: "general", nick: "ann_1" },
    });
  });

  it("trims message text", () => {
    const r = parse({ type: "message", text: "  hi  " });
    expect(r).toEqual({ ok: true, message: { type: "message", text: "hi" } });
  });

  it("accepts leave and ping", () => {
    expect(parse({ type: "leave" }).ok).toBe(true);
    expect(parse({ type: "ping" }).ok).toBe(true);
  });

  it("rejects non-JSON", () => {
    const r = parseClientMessage("{nope");
    expect(r).toMatchObject({ ok: false, code: "INVALID_JSON" });
  });

  it("rejects unknown types and non-objects", () => {
    expect(parse({ type: "explode" })).toMatchObject({ ok: false, code: "INVALID_MESSAGE" });
    expect(parse(42)).toMatchObject({ ok: false, code: "INVALID_MESSAGE" });
    expect(parse(null)).toMatchObject({ ok: false, code: "INVALID_MESSAGE" });
  });

  it("rejects bad nicks and rooms", () => {
    expect(parse({ type: "join", room: "r", nick: "has space" }).ok).toBe(false);
    expect(parse({ type: "join", room: "", nick: "a" }).ok).toBe(false);
    expect(parse({ type: "join", room: "x".repeat(LIMITS.maxRoomLength + 1), nick: "a" }).ok).toBe(false);
    expect(parse({ type: "join", room: "r", nick: "x".repeat(LIMITS.maxNickLength + 1) }).ok).toBe(false);
  });

  it("rejects empty, whitespace-only and oversized text", () => {
    expect(parse({ type: "message", text: "   " }).ok).toBe(false);
    expect(parse({ type: "message", text: "x".repeat(LIMITS.maxTextLength + 1) }).ok).toBe(false);
    expect(parse({ type: "message", text: "x".repeat(LIMITS.maxTextLength) }).ok).toBe(true);
  });

  it("reports the offending field path", () => {
    const r = parse({ type: "message", text: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/^text:/);
  });
});
