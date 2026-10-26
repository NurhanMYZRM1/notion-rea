import type {
  DatabaseInfo,
  PropertyDef,
  PropertyValue,
  RecordRow,
} from "@workspace/core";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AccessibilityInfo, Alert, Text, View } from "react-native";
import { api, conflictCurrent, errorMessage, useOnline } from "@/lib/api";
import { keys, kv } from "@/lib/queries";
import { useCachedQuery } from "@/lib/session";
import { colors } from "@/lib/theme";
import { choose, prompt, Row, SectionTitle } from "./ui";

export function optionName(
  def: PropertyDef,
  value: PropertyValue,
): string | null {
  return def.options?.find((o) => o.id === value)?.name ?? null;
}

/** Display text for a property value ("" when empty). */
export function formatValue(
  def: PropertyDef,
  value: PropertyValue | undefined,
): string {
  if (value === null || value === undefined || value === "")
    return def.type === "checkbox" ? "No" : "";
  switch (def.type) {
    case "checkbox":
      return value ? "Yes" : "No";
    case "select":
    case "status":
      return optionName(def, value) ?? "";
    case "number":
      return typeof value === "number" ? value.toLocaleString() : String(value);
    default:
      return String(value);
  }
}

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Native editor for one value, chosen by property type. Resolves to the new value, or undefined when
 * cancelled (null means "clear").
 */
export async function editProperty(
  def: PropertyDef,
  value: PropertyValue | undefined,
): Promise<PropertyValue | undefined> {
  const current = value ?? null;
  switch (def.type) {
    case "checkbox":
      return !current;
    case "select":
    case "status":
      return choose(def.name, [
        ...(def.options ?? []).map((o) => ({
          label: `${o.id === current ? "✓ " : ""}${o.name}`,
          value: o.id as PropertyValue,
        })),
        ...(current
          ? [
              {
                label: "Clear",
                value: null as PropertyValue,
                destructive: true,
              },
            ]
          : []),
      ]);
    case "date": {
      const today = new Date();
      const pick = await choose(def.name, [
        { label: "Today", value: isoDay(today) },
        { label: "Tomorrow", value: isoDay(new Date(today.getTime() + 864e5)) },
        { label: "Enter a date…", value: "enter" },
        ...(current
          ? [{ label: "Clear", value: "clear", destructive: true }]
          : []),
      ]);
      if (pick === "clear") return null;
      if (pick !== "enter") return pick;
      return askValidated(
        def,
        String(current ?? ""),
        "YYYY-MM-DD",
        "numbers-and-punctuation",
        (t) =>
          /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(t))
            ? t
            : undefined,
        "Use the format YYYY-MM-DD.",
      );
    }
    case "number":
      return askValidated(
        def,
        current === null ? "" : String(current),
        "Number",
        "numbers-and-punctuation",
        (t) => (Number.isFinite(Number(t)) ? Number(t) : undefined),
        "Enter a number.",
      );
    case "url":
      return askValidated(
        def,
        String(current ?? ""),
        "https://…",
        "url",
        (t) => {
          const v = /^(https?:\/\/|mailto:)/i.test(t) ? t : `https://${t}`;
          return v.length <= 2000 ? v : undefined;
        },
        "Enter a web address.",
      );
    default:
      return askValidated(
        def,
        String(current ?? ""),
        def.name,
        "default",
        (t) => t,
      );
  }
}

async function askValidated(
  def: PropertyDef,
  value: string,
  placeholder: string,
  keyboardType: "default" | "url" | "numbers-and-punctuation",
  parse: (text: string) => PropertyValue | undefined,
  hint?: string,
): Promise<PropertyValue | undefined> {
  for (;;) {
    const text = await prompt({
      title: def.name,
      value,
      placeholder,
      keyboardType,
    });
    if (text === null) return undefined;
    if (!text.trim()) return null;
    const parsed = parse(text.trim());
    if (parsed !== undefined) return parsed;
    await new Promise<void>((r) =>
      Alert.alert(
        `Invalid ${def.name}`,
        hint ?? "Check the value and try again.",
        [{ text: "OK", onPress: () => r() }],
      ),
    );
    value = text;
  }
}

/**
 * PATCH values at the record's revision. On 409 our single edit is re-applied on the server's current
 * revision once (it is the newest intent); anything else surfaces to the caller.
 */
export async function saveRecordValues(
  qc: QueryClient,
  record: Pick<RecordRow, "id" | "revision">,
  databaseId: string,
  values: Record<string, PropertyValue>,
): Promise<RecordRow> {
  let revision =
    qc.getQueryData<RecordRow>(keys.record(record.id))?.revision ??
    record.revision;
  for (let attempt = 0; ; attempt++) {
    try {
      const { record: saved } = await api.updateRecord(
        record.id,
        revision,
        values,
      );
      qc.setQueryData(keys.record(record.id), saved);
      void qc.invalidateQueries({ queryKey: keys.database(databaseId) });
      void qc.invalidateQueries({
        queryKey: keys.page(record.id),
        exact: true,
      });
      return saved;
    } catch (err) {
      const current = conflictCurrent<RecordRow>(err);
      if (!current || attempt > 0) throw err;
      AccessibilityInfo.announceForAccessibility(
        "Someone else changed this record; applying your change on top.",
      );
      revision = current.revision;
    }
  }
}

/** Native properties header of a record page: every non-title property, tap to edit. */
export function RecordProperties({
  recordId,
  databaseId,
  editable,
}: {
  recordId: string;
  databaseId: string;
  editable: boolean;
}) {
  const qc = useQueryClient();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const db = useCachedQuery<DatabaseInfo>(
    keys.database(databaseId),
    kv.database(databaseId),
    () => api.database(databaseId).then((r) => r.database),
  );
  const rec = useCachedQuery<RecordRow>(
    keys.record(recordId),
    kv.record(recordId),
    () => api.record(recordId).then((r) => r.record),
  );
  if (!db.data || !rec.data) return null;
  const props = db.data.schema.filter((p) => p.type !== "title");
  if (!props.length) return null;
  const shown = open ? props : props.slice(0, 4);
  const record = rec.data;
  const canEdit = editable && online;

  const edit = async (def: PropertyDef) => {
    const next = await editProperty(def, record.values[def.id]);
    if (next === undefined) return;
    try {
      await saveRecordValues(qc, record, databaseId, { [def.id]: next });
    } catch (err) {
      Alert.alert(`Couldn't save ${def.name}`, errorMessage(err));
    }
  };

  return (
    <View testID="record-properties">
      <SectionTitle>Properties</SectionTitle>
      {shown.map((def) => {
        const text = formatValue(def, record.values[def.id]);
        return (
          <Row
            key={def.id}
            title={def.name}
            detail={text || "Empty"}
            accessibilityLabel={`${def.name}: ${text || "empty"}`}
            accessibilityHint={
              canEdit
                ? "Double-tap to edit"
                : editable
                  ? "Editing needs a connection"
                  : undefined
            }
            onPress={canEdit ? () => void edit(def) : undefined}
          />
        );
      })}
      {props.length > 4 && (
        <Row
          title={
            open
              ? "Show fewer properties"
              : `Show all ${props.length} properties`
          }
          onPress={() => setOpen((o) => !o)}
        />
      )}
      {!online && editable && (
        <Text
          style={{
            paddingHorizontal: 16,
            paddingTop: 6,
            color: colors.secondaryLabel,
            fontSize: 13,
          }}
        >
          Property changes need a connection.
        </Text>
      )}
    </View>
  );
}
