/**
 * Native ⇄ editor WebView bridge, protocol v2. Only Yjs updates and awareness updates cross it,
 * as base64 inside a versioned envelope; no cookies, tokens or API access ever reach the WebView.
 * Imported by both sides (Hermes and the DOM bundle), so it must stay dependency-free.
 *
 * Sequence: DOM mounts → `onBridgeReady(href)` → native `applyInit(full state)` once → DOM mounts the
 * editor → `onReady()`. Then `onLocalUpdate`/`applyRemote` carry incremental updates only.
 */
export const BRIDGE_VERSION = 2;

/** A type alias (not an interface) so it stays assignable to expo/dom's JSON argument types. */
export type BridgeMsg = {
  v: typeof BRIDGE_VERSION;
  /** base64 of a Yjs update (applyInit/applyRemote/onLocalUpdate) or an awareness update. */
  b64: string;
};

/** What `pickAndUpload` resolves to (same shape as `Uploaded` in @workspace/editor). */
export type UploadedFile = {
  src: string;
  name: string;
  mimeType: string;
  size: number;
};

/** WebView → native: async function props of the editor DOM component. */
export type ChildPageMetadata = {
  id: string;
  title: string;
  icon?: string | null;
};

export interface EditorNativeProps {
  resolvePages(pageIds: string[]): Promise<ChildPageMetadata[]>;
  createSubpage(input: { afterBlockId?: string }): Promise<ChildPageMetadata>;
  openPage(pageId: string): Promise<void>;
  archivePage(pageId: string): Promise<void>;
  movePage(pageId: string): Promise<void>;
  /** Imperative handle registered; `href` is the editor document (the only URL it may load). */
  onBridgeReady(href: string): Promise<void>;
  /** The editor is mounted after `applyInit` (open-to-editable). */
  onReady(): Promise<void>;
  onLocalUpdate(msg: BridgeMsg): Promise<void>;
  onAwareness(msg: BridgeMsg): Promise<void>;
  /** Native opens only http(s)/mailto, outside the WebView. */
  onOpenLink(url: string): Promise<void>;
  onError(message: string): Promise<void>;
  pickAndUpload(kind: "image" | "file"): Promise<UploadedFile | null>;
  /** Stored src (`/api/attachments/…`) → URI the WebView can load. Rejects when offline and uncached. */
  resolveSrc(src: string): Promise<string>;
  openFile(src: string, name: string): Promise<void>;
}

/**
 * Native → WebView (useDOMImperativeHandle). Fire-and-forget, delivered in call order.
 * A type alias with method syntax so it satisfies expo/dom's `DOMImperativeFactory`.
 */
export type EditorHandle = {
  applyInit(msg: BridgeMsg): void;
  applyRemote(msg: BridgeMsg): void;
  applyAwareness(msg: BridgeMsg): void;
  setEditable(editable: boolean): void;
  refreshPageMetadata(): void;
  setTheme(scheme: "light" | "dark"): void;
};

const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK)
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
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

/** Validates the envelope; throws on anything that is not a v2 message so a mismatched bundle fails loudly. */
export function decodeMsg(msg: unknown): Uint8Array {
  if (typeof msg !== "object" || msg === null)
    throw new Error("bridge: not a message");
  const { v, b64 } = msg as Partial<BridgeMsg>;
  if (v !== BRIDGE_VERSION)
    throw new Error(`bridge: unsupported version ${String(v)}`);
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64))
    throw new Error("bridge: bad payload");
  return fromBase64(b64);
}

/** Links the editor may open: only http(s) and mailto. Everything else is refused. */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4000) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "mailto:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** Attachment id from a stored src; anything else is not ours to fetch with the session cookie. */
export function attachmentId(src: unknown): string | null {
  const m =
    typeof src === "string"
      ? /^\/api\/attachments\/([a-z]{1,4}_[0-9A-Za-z]{8,40})$/.exec(src)
      : null;
  return m?.[1] ?? null;
}

/**
 * The WebView may only (re)load its own editor document. `documentUrl` is null until the bundle
 * reported itself, i.e. during the initial load (iOS asks for it; Android does not).
 */
export function navigationAllowed(
  documentUrl: string | null,
  requestUrl: string,
): boolean {
  if (documentUrl === null) return true;
  return (
    requestUrl === "about:blank" ||
    requestUrl.split("#")[0] === documentUrl.split("#")[0]
  );
}
