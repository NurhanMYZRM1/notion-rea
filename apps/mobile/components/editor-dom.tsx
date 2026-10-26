"use dom";

// The app's only DOM component: the shared rich-text editor over a WebView-local Y.Doc replica.
// It has no network, cookies or native-module access; everything goes through lib/bridge.ts.
import "@workspace/editor/styles.css";
import "./editor-dom.css";
import { WorkspaceEditor } from "@workspace/editor";
import { type DOMImperativeFactory, type DOMProps, useDOMImperativeHandle } from "expo/dom";
import { type Ref, useEffect, useRef, useState } from "react";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { decodeMsg, type EditorHandle, type EditorNativeProps, encodeMsg } from "../lib/bridge";

const NATIVE = "native";

export type EditorDomHandle = EditorHandle;

type Props = EditorNativeProps & {
  ref: Ref<EditorDomHandle>;
  user: { name: string; color: string };
  dom?: DOMProps;
};

export default function EditorDom(props: Props) {
  const [doc] = useState(() => new Y.Doc());
  const [awareness] = useState(() => new Awareness(doc));
  const [initialized, setInitialized] = useState(false);
  const [editable, setEditable] = useState(false);
  const p = useRef(props);
  p.current = props;

  // Arguments arrive as untyped JSON from injected JS; decodeMsg validates every payload.
  useDOMImperativeHandle(
    props.ref as Ref<DOMImperativeFactory>,
    (): EditorHandle & DOMImperativeFactory => ({
      applyInit: (msg: unknown) => {
        Y.applyUpdate(doc, decodeMsg(msg), NATIVE);
        setInitialized(true);
      },
      applyRemote: (msg: unknown) => Y.applyUpdate(doc, decodeMsg(msg), NATIVE),
      applyAwareness: (msg: unknown) => applyAwarenessUpdate(awareness, decodeMsg(msg), NATIVE),
      setEditable: (value: unknown) => setEditable(value === true),
    }),
    [doc, awareness],
  );

  useEffect(() => {
    // Incremental updates only: one small message per edit, never the whole document.
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin !== NATIVE) void p.current.onLocalUpdate(encodeMsg(update));
    };
    const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin !== NATIVE) void p.current.onAwareness(encodeMsg(encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed])));
    };
    // Links never navigate the WebView: taps on read-only links and window.open go to the native side.
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      e.preventDefault();
      const editing = !!a.closest('[contenteditable="true"]');
      if (!editing && !a.closest(".file-attachment")) void p.current.onOpenLink((a as HTMLAnchorElement).href);
    };
    const open = window.open;
    window.open = (url?: string | URL) => {
      if (url) void p.current.onOpenLink(String(url));
      return null;
    };
    // Keep the fixed toolbar on top of the keyboard: lift it by the part of the layout viewport the keyboard covers.
    const vv = window.visualViewport;
    const lift = () => {
      const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
      document.documentElement.style.setProperty("--kb", `${Math.round(kb)}px`);
      document.documentElement.classList.toggle("kb-open", kb > 40);
    };
    vv?.addEventListener("resize", lift);
    vv?.addEventListener("scroll", lift);
    doc.on("update", onUpdate);
    awareness.on("update", onAwareness);
    document.addEventListener("click", onClick, true);
    void p.current.onBridgeReady(location.href);
    return () => {
      vv?.removeEventListener("resize", lift);
      vv?.removeEventListener("scroll", lift);
      doc.off("update", onUpdate);
      awareness.off("update", onAwareness);
      document.removeEventListener("click", onClick, true);
      window.open = open;
    };
  }, [doc, awareness]);

  // "Editable" = editor committed after applyInit. Not tied to Tiptap's onCreate: an extension throwing
  // there (UniqueID with a provider lacking on/off) aborts later create listeners.
  useEffect(() => {
    if (initialized) requestAnimationFrame(() => void p.current.onReady());
  }, [initialized]);

  if (!initialized) return null;
  return (
    <main className="mobile-editor">
      <WorkspaceEditor
        doc={doc}
        awareness={awareness}
        user={props.user}
        editable={editable}
        toolbar="fixed"
        placeholder="Tap to write, type / for blocks"
        pickAndUpload={(kind) => p.current.pickAndUpload(kind)}
        resolveSrc={(src) => p.current.resolveSrc(src)}
        openFile={(src, name) => void p.current.openFile(src, name)}
        onError={(message) => void p.current.onError(message)}
      />
    </main>
  );
}
