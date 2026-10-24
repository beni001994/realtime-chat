import type { HistoryEntry } from "./protocol.js";

interface Room {
  members: Map<string, string>; // connection id -> nick
  history: HistoryEntry[];
}

export type JoinResult =
  | { ok: true; room: string; users: string[]; history: HistoryEntry[]; others: string[] }
  | { ok: false; code: "ALREADY_IN_ROOM" | "NICK_TAKEN" };

export type PostResult =
  | { ok: false; code: "NOT_IN_ROOM" }
  | { ok: true; room: string; entry: HistoryEntry; recipients: string[] };

export interface LeaveResult {
  room: string;
  nick: string;
  /** Connection ids still in the room (to notify). */
  remaining: string[];
}

/**
 * Pure in-memory room state. It knows nothing about sockets: connections are
 * opaque string ids and every method returns who should be notified.
 * A room is deleted (history included) when its last member leaves.
 */
export class RoomManager {
  private rooms = new Map<string, Room>();
  private membership = new Map<string, string>(); // connection id -> room name

  constructor(private readonly historyLimit: number) {
    if (historyLimit < 0) throw new RangeError("historyLimit must be >= 0");
  }

  join(id: string, roomName: string, nick: string): JoinResult {
    if (this.membership.has(id)) return { ok: false, code: "ALREADY_IN_ROOM" };
    let room = this.rooms.get(roomName);
    if (room) {
      const taken = [...room.members.values()].some((n) => n.toLowerCase() === nick.toLowerCase());
      if (taken) return { ok: false, code: "NICK_TAKEN" };
    } else {
      room = { members: new Map(), history: [] };
      this.rooms.set(roomName, room);
    }
    const others = [...room.members.keys()];
    room.members.set(id, nick);
    this.membership.set(id, roomName);
    return {
      ok: true,
      room: roomName,
      users: [...room.members.values()],
      history: [...room.history],
      others,
    };
  }

  leave(id: string): LeaveResult | undefined {
    const roomName = this.membership.get(id);
    if (roomName === undefined) return undefined;
    const room = this.rooms.get(roomName)!;
    const nick = room.members.get(id)!;
    room.members.delete(id);
    this.membership.delete(id);
    if (room.members.size === 0) this.rooms.delete(roomName);
    return { room: roomName, nick, remaining: [...room.members.keys()] };
  }

  post(id: string, text: string, ts: number): PostResult {
    const roomName = this.membership.get(id);
    if (roomName === undefined) return { ok: false, code: "NOT_IN_ROOM" };
    const room = this.rooms.get(roomName)!;
    const entry: HistoryEntry = { nick: room.members.get(id)!, text, ts };
    room.history.push(entry);
    if (room.history.length > this.historyLimit) {
      room.history.splice(0, room.history.length - this.historyLimit);
    }
    return { ok: true, room: roomName, entry, recipients: [...room.members.keys()] };
  }

  roomOf(id: string): string | undefined {
    return this.membership.get(id);
  }

  get roomCount(): number {
    return this.rooms.size;
  }
}
