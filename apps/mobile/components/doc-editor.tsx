import type { DOMProps } from "expo/dom";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { memo, useEffect, useMemo, useRef } from "react";
import { Alert } from "react-native";
import { openFile, pickAndUpload, resolveSrc } from "@/lib/attachments";
import { errorMessage } from "@/lib/api";
import { navigationAllowed, safeExternalUrl } from "@/lib/bridge";
import type { DocSession } from "@/lib/doc-session";
import EditorDom, { type EditorDomHandle } from "./editor-dom";

/**
 * Hosts the editor WebView for one DocSession. Memoized with stable callbacks: every re-render of a
 * DOM component re-sends all its props into the WebView, so typing must never re-render this.
 */
export const DocEditor = memo(function DocEditor(p: { session: DocSession; editable: boolean; user: { name: string; color: string }; onReady?: () => void }) {
  const ref = useRef<EditorDomHandle>(null);
  const documentUrl = useRef<string | null>(null);
  const onReady = useRef(p.onReady);
  onReady.current = p.onReady;
  const { session } = p;

  useEffect(() => session.setEditable(p.editable), [session, p.editable]);

  const actions = useMemo(
    () => ({
      onBridgeReady: async (href: string) => {
        documentUrl.current = href;
        if (ref.current) session.attach(ref.current);
      },
      onReady: async () => onReady.current?.(),
      onLocalUpdate: async (msg: Parameters<DocSession["localUpdate"]>[0]) => session.localUpdate(msg),
      onAwareness: async (msg: Parameters<DocSession["localAwareness"]>[0]) => session.localAwareness(msg),
      onOpenLink: async (raw: string) => {
        const url = safeExternalUrl(raw);
        if (!url) return;
        if (url.startsWith("mailto:")) await Linking.openURL(url);
        else await WebBrowser.openBrowserAsync(url);
      },
      onError: async (message: string) => Alert.alert("Couldn't add the file", message),
      pickAndUpload: (kind: "image" | "file") =>
        pickAndUpload(session.pageId, kind).catch((err: unknown) => {
          throw new Error(errorMessage(err));
        }),
      resolveSrc,
      openFile: (src: string) =>
        openFile(src).catch((err: unknown) => {
          Alert.alert("Couldn't open the file", errorMessage(err));
        }),
    }),
    [session],
  );

  const dom = useMemo<DOMProps>(
    () => ({
      // react-native-webview: the only engine here with a navigation policy hook.
      useExpoDOMWebView: false,
      style: { flex: 1 },
      hideKeyboardAccessoryView: true,
      keyboardDisplayRequiresUserAction: false,
      sharedCookiesEnabled: false,
      onShouldStartLoadWithRequest: (req) => navigationAllowed(documentUrl.current, req.url),
      setSupportMultipleWindows: false,
      allowsBackForwardNavigationGestures: false,
      allowsLinkPreview: false,
      dataDetectorTypes: "none",
    }),
    [],
  );

  return <EditorDom ref={ref} user={p.user} dom={dom} {...actions} />;
});
