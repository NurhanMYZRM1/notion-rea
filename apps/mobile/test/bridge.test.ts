import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { BRIDGE_VERSION, decodeMsg, encodeMsg, fromBase64, safeExternalUrl, toBase64 } from "../lib/bridge.ts";

test("base64 round-trips every byte value and large buffers", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(fromBase64(toBase64(all)), all);
  const big = new Uint8Array(300_000).map((_, i) => (i * 31) % 251);
  assert.deepEqual(fromBase64(toBase64(big)), big);
  assert.deepEqual(fromBase64(toBase64(new Uint8Array())), new Uint8Array());
});

test("a Yjs update survives the envelope and converges a second doc", () => {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array) => Y.applyUpdate(b, decodeMsg(JSON.parse(JSON.stringify(encodeMsg(u))))));
  a.getText("t").insert(0, "héllo 日本語 שלום 👋");
  assert.equal(b.getText("t").toString(), "héllo 日本語 שלום 👋");
  const msg = encodeMsg(Y.encodeStateAsUpdate(a));
  assert.equal(msg.v, BRIDGE_VERSION);
  const c = new Y.Doc();
  Y.applyUpdate(c, decodeMsg(msg));
  assert.equal(c.getText("t").toString(), a.getText("t").toString());
});

test("decode rejects wrong versions and malformed payloads", () => {
  assert.throws(() => decodeMsg({ v: 2, b64: "AA==" }), /version/);
  assert.throws(() => decodeMsg({ v: 1, b64: "<script>" }), /payload/);
  assert.throws(() => decodeMsg(null), /message/);
  assert.throws(() => decodeMsg("AA=="), /message/);
});

test("only http(s) and mailto links may leave the editor", () => {
  assert.equal(safeExternalUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(safeExternalUrl("mailto:a@example.com"), "mailto:a@example.com");
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalUrl("file:///etc/passwd"), null);
  assert.equal(safeExternalUrl("workspace://invite/x"), null);
  assert.equal(safeExternalUrl("not a url"), null);
  assert.equal(safeExternalUrl(42), null);
});
