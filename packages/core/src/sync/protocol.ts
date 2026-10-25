import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

/**
 * Wire protocol over one binary WebSocket per open page.
 *  0 SYNC      y-protocols sync (step1 / step2 / update)
 *  1 AWARENESS y-protocols awareness update (presence, carets)
 *  2 ACK       server → client: the client's oldest unacknowledged sync step2/update message
 *              has been committed to Durable Object storage; carries the document revision.
 *  3 CONTROL   server → client JSON (see Control)
 */
export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_ACK = 2;
export const MSG_CONTROL = 3;

export const PROTOCOL_VERSION = 1;

export type Control =
  | { type: "hello"; revision: number; role: "owner" | "editor" | "viewer"; state: "active" | "archived"; v: number }
  | { type: "read-only"; reason: "viewer" | "archived" }
  | { type: "state"; state: "active" | "archived" }
  | { type: "revoked" }
  | { type: "deleted" }
  | { type: "error"; message: string };

/** WebSocket close codes used when the server ends a document session. */
export const CLOSE = {
  unauthenticated: 4401,
  forbidden: 4403,
  notFound: 4404,
  deleted: 4410,
  tooLarge: 4413,
} as const;

export function encodeAck(revision: number): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MSG_ACK);
  encoding.writeVarUint(e, revision);
  return encoding.toUint8Array(e);
}

export function encodeControl(control: Control): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MSG_CONTROL);
  encoding.writeVarString(e, JSON.stringify(control));
  return encoding.toUint8Array(e);
}

export function readAck(d: decoding.Decoder): number {
  return decoding.readVarUint(d);
}

export function readControl(d: decoding.Decoder): Control {
  return JSON.parse(decoding.readVarString(d)) as Control;
}

/** Client ids contained in an awareness update (used to clear presence when a socket closes). */
export function awarenessClientIds(update: Uint8Array): number[] {
  const d = decoding.createDecoder(update);
  const count = decoding.readVarUint(d);
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(decoding.readVarUint(d));
    decoding.readVarUint(d); // clock
    decoding.readVarString(d); // state JSON
  }
  return ids;
}

/** Awareness update that marks the given clients as gone (state null), as y-protocols does on timeout. */
export function encodeAwarenessRemoval(clients: { id: number; clock: number }[]): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, clients.length);
  for (const c of clients) {
    encoding.writeVarUint(e, c.id);
    encoding.writeVarUint(e, c.clock + 1);
    encoding.writeVarString(e, "null");
  }
  return encoding.toUint8Array(e);
}

export function awarenessClocks(update: Uint8Array): { id: number; clock: number }[] {
  const d = decoding.createDecoder(update);
  const count = decoding.readVarUint(d);
  const out: { id: number; clock: number }[] = [];
  for (let i = 0; i < count; i++) {
    const id = decoding.readVarUint(d);
    const clock = decoding.readVarUint(d);
    decoding.readVarString(d);
    out.push({ id, clock });
  }
  return out;
}
