import * as encoding from "lib0/encoding";
import * as sync from "y-protocols/sync";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CLOSE, encodeAck, encodeControl, MSG_SYNC, SyncProvider } from "../src/sync";

class Socket extends EventTarget {
  readyState = 1;
  binaryType = "";
  sent: Uint8Array[] = [];
  send(data: Uint8Array) { this.sent.push(data); }
  close(code = 1000) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
  receive(data: Uint8Array) {
    this.dispatchEvent(Object.assign(new Event("message"), { data: data.slice().buffer }));
  }
  handshake() {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    const remote = new Y.Doc();
    sync.writeSyncStep1(encoder, remote);
    remote.destroy();
    this.receive(encoding.toUint8Array(encoder));
  }
}

const providers: SyncProvider[] = [];
afterEach(() => {
  for (const provider of providers.splice(0)) {
    provider.destroy();
    provider.awareness.destroy();
    provider.doc.destroy();
  }
});

async function session() {
  const socket = new Socket();
  const provider = new SyncProvider({ doc: new Y.Doc(), store: null, connect: () => socket as unknown as WebSocket, batchMs: 10_000 });
  providers.push(provider);
  await provider.start();
  return { socket, provider };
}

describe("structural edit sync barrier", () => {
  it("does not claim sync before the initial handshake is durably acknowledged", async () => {
    const { socket, provider } = await session();
    let done = false;
    const waiting = provider.awaitSynced().then(() => { done = true; });
    await Promise.resolve();
    expect(provider.current.phase).toBe("syncing");
    expect(done).toBe(false);
    socket.handshake();
    await Promise.resolve();
    expect(done).toBe(false);
    socket.receive(encodeAck(1));
    await waiting;
    expect(done).toBe(true);
    expect(provider.current.phase).toBe("synced");
  });

  it("flushes the typing batch immediately and waits for its ACK", async () => {
    const { socket, provider } = await session();
    socket.handshake(); socket.receive(encodeAck(1));
    provider.doc.getText("text").insert(0, "anchor");
    const before = socket.sent.length;
    let done = false;
    const waiting = provider.awaitSynced().then(() => { done = true; });
    expect(socket.sent.length).toBe(before + 1);
    await Promise.resolve(); expect(done).toBe(false);
    socket.receive(encodeAck(2));
    await waiting;
    expect(provider.current.pendingLocal).toBe(false);
  });

  it("waits for the ACK covering offline edits recovered during handshake", async () => {
    const { socket, provider } = await session();
    provider.doc.getText("text").insert(0, "before handshake");
    const waiting = provider.awaitSynced();
    socket.handshake();
    expect(provider.current.pendingLocal).toBe(true);
    socket.receive(encodeAck(4));
    await waiting;
    expect(provider.current.revision).toBe(4);
  });

  it("rejects disconnects, upgrade requirements, read-only sessions, timeout, and disposal", async () => {
    const first = await session();
    const offline = first.provider.awaitSynced();
    first.socket.close();
    await expect(offline).rejects.toThrow("Connect to the internet");

    const second = await session();
    const upgrade = second.provider.awaitSynced();
    second.socket.receive(encodeControl({ type: "upgrade-required", requiredSchemaVersion: 2 }));
    await expect(upgrade).rejects.toThrow("Update the app");
    expect(second.provider.current.failure).toBe("upgrade-required");

    const third = await session();
    third.socket.close(CLOSE.upgradeRequired);
    await expect(third.provider.awaitSynced()).rejects.toThrow("Update the app");

    const fourth = await session();
    fourth.socket.receive(encodeControl({ type: "read-only", reason: "viewer" }));
    await expect(fourth.provider.awaitSynced()).rejects.toThrow("read-only");

    const fifth = await session();
    await expect(fifth.provider.awaitSynced(5)).rejects.toThrow("Timed out");
    const disposed = fifth.provider.awaitSynced();
    fifth.provider.destroy();
    await expect(disposed).rejects.toThrow("closed");
  });
});
