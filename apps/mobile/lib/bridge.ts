/**
 * Native ⇄ editor WebView bridge, protocol v1. Only Yjs updates and awareness updates cross it,
 * as base64 inside a versioned envelope; no cookies, tokens or API access ever reach the WebView.
 * Imported by both sides (Hermes and the DOM bundle), so it must stay dependency-free.
 */
export const BRIDGE_VERSION = 1;

export interface BridgeMsg {
  v: typeof BRIDGE_VERSION;
  /** base64 of a Yjs update (applyInit/applyRemote/onLocalUpdate) or an awareness update. */
  b64: string;
}

/** What `pickAndUpload` resolves to (same shape as `Uploaded` in @workspace/editor). */
export interface UploadedFile {
  src: string;
  name: string;
  mimeType: string;
  size: number;
}

const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeMsg(bytes: Uint8Array): BridgeMsg {
  return { v: BRIDGE_VERSION, b64: toBase64(bytes) };
}

/** Validates the envelope; throws on anything that is not a v1 message so a mismatched bundle fails loudly. */
export function decodeMsg(msg: unknown): Uint8Array {
  if (typeof msg !== "object" || msg === null) throw new Error("bridge: not a message");
  const { v, b64 } = msg as Partial<BridgeMsg>;
  if (v !== BRIDGE_VERSION) throw new Error(`bridge: unsupported version ${String(v)}`);
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error("bridge: bad payload");
  return fromBase64(b64);
}

/** Links the editor may open: only http(s) and mailto. Everything else is refused. */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4000) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.toString() : null;
  } catch {
    return null;
  }
}
