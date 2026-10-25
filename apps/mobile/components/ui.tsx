import type { SyncPhase } from "@workspace/core/sync";
import { type ReactNode, useSyncExternalStore } from "react";
import { ActionSheetIOS, ActivityIndicator, Modal, Platform, Pressable, ScrollView, Text, View, type ViewStyle } from "react-native";
import { colors, HIT } from "@/lib/theme";

export function Row(p: {
  title: string;
  subtitle?: string;
  detail?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  destructive?: boolean;
  disabled?: boolean;
  indent?: number;
  left?: ReactNode;
  right?: ReactNode;
  accessibilityHint?: string;
  accessibilityLabel?: string;
  testID?: string;
}) {
  return (
    <Pressable
      testID={p.testID}
      onPress={p.onPress}
      onLongPress={p.onLongPress}
      disabled={p.disabled || (!p.onPress && !p.onLongPress)}
      accessibilityRole={p.onPress ? "button" : undefined}
      accessibilityLabel={p.accessibilityLabel ?? [p.title, p.subtitle, p.detail].filter(Boolean).join(", ")}
      accessibilityHint={p.accessibilityHint}
      accessibilityState={{ disabled: !!p.disabled }}
      style={({ pressed }) => ({
        minHeight: HIT,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingLeft: 16 + (p.indent ?? 0) * 16,
        paddingRight: 16,
        paddingVertical: 8,
        backgroundColor: pressed ? colors.fill : colors.card,
        opacity: p.disabled ? 0.5 : 1,
      })}
    >
      {p.left}
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={2} style={{ fontSize: 17, color: p.destructive ? colors.danger : colors.label }}>
          {p.title}
        </Text>
        {!!p.subtitle && (
          <Text selectable numberOfLines={3} style={{ fontSize: 14, color: colors.secondaryLabel }}>
            {p.subtitle}
          </Text>
        )}
      </View>
      {!!p.detail && <Text style={{ fontSize: 15, color: colors.secondaryLabel }}>{p.detail}</Text>}
      {p.right}
    </Pressable>
  );
}

export function SectionTitle({ children }: { children: string }) {
  return (
    <Text accessibilityRole="header" style={{ fontSize: 13, fontWeight: "600", color: colors.secondaryLabel, textTransform: "uppercase", paddingHorizontal: 16, paddingTop: 22, paddingBottom: 6 }}>
      {children}
    </Text>
  );
}

export function Button(p: { title: string; onPress: () => void; kind?: "filled" | "plain" | "destructive"; disabled?: boolean; busy?: boolean; accessibilityHint?: string; style?: ViewStyle; testID?: string }) {
  const kind = p.kind ?? "filled";
  const disabled = p.disabled || p.busy;
  return (
    <Pressable
      onPress={p.onPress}
      disabled={disabled}
      testID={p.testID}
      accessibilityRole="button"
      accessibilityLabel={p.title}
      accessibilityHint={p.accessibilityHint}
      accessibilityState={{ disabled: !!disabled, busy: !!p.busy }}
      style={({ pressed }) => ({
        minHeight: HIT,
        minWidth: HIT,
        paddingHorizontal: 16,
        borderRadius: 10,
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: 8,
        backgroundColor: kind === "filled" ? colors.tint : "transparent",
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
        ...p.style,
      })}
    >
      {p.busy && <ActivityIndicator color={kind === "filled" ? (colors.onTint as string) : undefined} />}
      <Text style={{ fontSize: 17, fontWeight: "600", color: kind === "filled" ? colors.onTint : kind === "destructive" ? colors.danger : colors.tint }}>{p.title}</Text>
    </Pressable>
  );
}

/** Text/glyph button for navigation bars (≥44pt hit area). */
export function HeaderButton(p: { label: string; glyph?: string; onPress: () => void; disabled?: boolean; accessibilityHint?: string }) {
  return (
    <Pressable
      onPress={p.onPress}
      disabled={p.disabled}
      accessibilityRole="button"
      accessibilityLabel={p.label}
      accessibilityHint={p.accessibilityHint}
      accessibilityState={{ disabled: !!p.disabled }}
      hitSlop={6}
      style={({ pressed }) => ({ minWidth: HIT, minHeight: HIT, alignItems: "center", justifyContent: "center", opacity: p.disabled ? 0.35 : pressed ? 0.5 : 1 })}
    >
      <Text maxFontSizeMultiplier={1.6} style={{ fontSize: p.glyph ? 22 : 17, color: colors.tint }}>
        {p.glyph ?? p.label}
      </Text>
    </Pressable>
  );
}

export function Banner(p: { tone: "info" | "warning" | "danger"; message: string; actions?: { label: string; onPress: () => void }[] }) {
  const color = p.tone === "danger" ? colors.danger : p.tone === "warning" ? colors.warning : colors.secondaryLabel;
  return (
    <View accessibilityRole="alert" style={{ marginHorizontal: 16, marginVertical: 6, padding: 12, gap: 6, borderRadius: 10, borderCurve: "continuous", backgroundColor: colors.warningBg, borderLeftWidth: 4, borderLeftColor: color }}>
      <Text selectable style={{ fontSize: 15, color: colors.label }}>
        {p.message}
      </Text>
      {!!p.actions?.length && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
          {p.actions.map((a) => (
            <Button key={a.label} kind="plain" title={a.label} onPress={a.onPress} style={{ paddingHorizontal: 8 }} />
          ))}
        </View>
      )}
    </View>
  );
}

const PHASE_LABEL: Record<SyncPhase, string> = {
  loading: "Loading…",
  "saving-local": "Saving locally…",
  "saved-device": "Saved on device",
  syncing: "Syncing…",
  synced: "Synced",
  offline: "Offline",
  failed: "Couldn't sync",
};

export function StatusPill({ phase }: { phase: SyncPhase }) {
  const tone = phase === "failed" ? colors.danger : phase === "synced" ? colors.success : phase === "offline" || phase === "saved-device" ? colors.warning : colors.secondaryLabel;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Sync status: ${PHASE_LABEL[phase]}`}
      accessibilityLiveRegion="polite"
      testID="sync-status"
      style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99, backgroundColor: colors.fill }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone }} />
      <Text style={{ fontSize: 13, color: colors.secondaryLabel }}>{PHASE_LABEL[phase]}</Text>
    </View>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12, backgroundColor: colors.grouped }}>{children}</View>;
}

export function Message({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <Centered>
      <Text accessibilityRole="header" style={{ fontSize: 20, fontWeight: "600", color: colors.label, textAlign: "center" }}>
        {title}
      </Text>
      {!!body && (
        <Text selectable style={{ fontSize: 16, color: colors.secondaryLabel, textAlign: "center" }}>
          {body}
        </Text>
      )}
      {children}
    </Centered>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <Centered>
      <ActivityIndicator accessibilityLabel={label} />
    </Centered>
  );
}

// ---------- action sheet (native on iOS, simple modal list on Android) ----------

export interface SheetAction {
  label: string;
  destructive?: boolean;
  onPress: () => void;
}
interface SheetState {
  title?: string;
  message?: string;
  actions: SheetAction[];
}
let sheet: SheetState | null = null;
const sheetListeners = new Set<() => void>();
const setSheet = (s: SheetState | null) => {
  sheet = s;
  sheetListeners.forEach((l) => l());
};

export function showActions(s: SheetState) {
  if (Platform.OS === "ios") {
    const labels = [...s.actions.map((a) => a.label), "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: s.title,
        message: s.message,
        options: labels,
        cancelButtonIndex: labels.length - 1,
        destructiveButtonIndex: s.actions.flatMap((a, i) => (a.destructive ? [i] : [])),
      },
      (i) => s.actions[i]?.onPress(),
    );
  } else setSheet(s);
}

/** Mounted once at the root; renders Android action sheets. */
export function ActionSheetHost() {
  const s = useSyncExternalStore(
    (l) => {
      sheetListeners.add(l);
      return () => sheetListeners.delete(l);
    },
    () => sheet,
  );
  if (Platform.OS === "ios") return null;
  return (
    <Modal visible={!!s} transparent animationType="slide" onRequestClose={() => setSheet(null)}>
      <Pressable accessibilityLabel="Close" style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.3)" }} onPress={() => setSheet(null)} />
      <View style={{ backgroundColor: colors.card, paddingBottom: 24, maxHeight: "70%" }}>
        {!!s?.title && <SectionTitle>{s.title}</SectionTitle>}
        <ScrollView>
          {s?.actions.map((a) => (
            <Row
              key={a.label}
              title={a.label}
              destructive={a.destructive}
              onPress={() => {
                setSheet(null);
                a.onPress();
              }}
            />
          ))}
          <Row title="Cancel" onPress={() => setSheet(null)} />
        </ScrollView>
      </View>
    </Modal>
  );
}
