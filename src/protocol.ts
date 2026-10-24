import { z } from "zod";

export const LIMITS = {
  maxRoomLength: 32,
  maxNickLength: 24,
  maxTextLength: 500,
} as const;

const name = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, "only letters, digits, '_' and '-' are allowed");

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("join"),
    room: name(LIMITS.maxRoomLength),
    nick: name(LIMITS.maxNickLength),
  }),
  z.object({
    type: z.literal("message"),
    text: z.string().trim().min(1).max(LIMITS.maxTextLength),
  }),
  z.object({ type: z.literal("leave") }),
  z.object({ type: z.literal("ping") }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ErrorCode =
  | "INVALID_JSON"
  | "INVALID_MESSAGE"
  | "NOT_IN_ROOM"
  | "ALREADY_IN_ROOM"
  | "NICK_TAKEN"
  | "RATE_LIMITED";

export interface HistoryEntry {
  nick: string;
  text: string;
  ts: number;
}

export type ServerMessage =
  | { type: "joined"; room: string; nick: string; users: string[]; history: HistoryEntry[] }
  | { type: "left"; room: string }
  | { type: "user_joined"; room: string; nick: string }
  | { type: "user_left"; room: string; nick: string }
  | { type: "message"; room: string; nick: string; text: string; ts: number }
  | { type: "pong" }
  | { type: "error"; code: ErrorCode; message: string };

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: "INVALID_JSON" | "INVALID_MESSAGE"; message: string };

/** Parse a raw frame (already decoded to a string) into a validated client message. */
export function parseClientMessage(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, code: "INVALID_JSON", message: "Frame is not valid JSON" };
  }
  const result = ClientMessageSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join(".");
    return {
      ok: false,
      code: "INVALID_MESSAGE",
      message: path ? `${path}: ${issue.message}` : issue.message,
    };
  }
  return { ok: true, message: result.data };
}

export function serialize(message: ServerMessage): string {
  return JSON.stringify(message);
}
