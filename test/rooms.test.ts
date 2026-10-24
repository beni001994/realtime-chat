import { describe, expect, it } from "vitest";
import { RoomManager } from "../src/rooms.js";

describe("RoomManager", () => {
  it("creates a room on first join and lists users", () => {
    const rm = new RoomManager(10);
    expect(rm.join("c1", "general", "ann")).toMatchObject({
      ok: true,
      users: ["ann"],
      history: [],
      others: [],
    });
    expect(rm.join("c2", "general", "bob")).toMatchObject({
      ok: true,
      users: ["ann", "bob"],
      others: ["c1"],
    });
  });

  it("rejects duplicate nicks case-insensitively within a room only", () => {
    const rm = new RoomManager(10);
    rm.join("c1", "a", "Ann");
    expect(rm.join("c2", "a", "ann")).toEqual({ ok: false, code: "NICK_TAKEN" });
    expect(rm.join("c2", "b", "ann").ok).toBe(true);
  });

  it("rejects joining twice on one connection", () => {
    const rm = new RoomManager(10);
    rm.join("c1", "a", "ann");
    expect(rm.join("c1", "b", "ann")).toEqual({ ok: false, code: "ALREADY_IN_ROOM" });
  });

  it("posts to the room and returns recipients", () => {
    const rm = new RoomManager(10);
    rm.join("c1", "a", "ann");
    rm.join("c2", "a", "bob");
    expect(rm.post("c1", "hi", 123)).toEqual({
      ok: true,
      room: "a",
      entry: { nick: "ann", text: "hi", ts: 123 },
      recipients: ["c1", "c2"],
    });
  });

  it("refuses to post when not in a room", () => {
    expect(new RoomManager(10).post("x", "hi", 1)).toEqual({ ok: false, code: "NOT_IN_ROOM" });
  });

  it("bounds history, keeping the newest entries", () => {
    const rm = new RoomManager(3);
    rm.join("c1", "a", "ann");
    for (let i = 1; i <= 5; i++) rm.post("c1", `m${i}`, i);
    const r = rm.join("c2", "a", "bob");
    expect(r.ok && r.history.map((h) => h.text)).toEqual(["m3", "m4", "m5"]);
  });

  it("history limit 0 stores nothing", () => {
    const rm = new RoomManager(0);
    rm.join("c1", "a", "ann");
    rm.post("c1", "x", 1);
    const r = rm.join("c2", "a", "bob");
    expect(r.ok && r.history).toEqual([]);
  });

  it("leave reports remaining members and frees the nick", () => {
    const rm = new RoomManager(10);
    rm.join("c1", "a", "ann");
    rm.join("c2", "a", "bob");
    expect(rm.leave("c1")).toEqual({ room: "a", nick: "ann", remaining: ["c2"] });
    expect(rm.join("c3", "a", "ann").ok).toBe(true);
    expect(rm.leave("nobody")).toBeUndefined();
  });

  it("deletes empty rooms along with their history", () => {
    const rm = new RoomManager(10);
    rm.join("c1", "a", "ann");
    rm.post("c1", "hi", 1);
    rm.leave("c1");
    expect(rm.roomCount).toBe(0);
    const r = rm.join("c2", "a", "bob");
    expect(r.ok && r.history).toEqual([]);
  });
});
