import { can, type MemberInfo, type Role, ROLES } from "@workspace/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { Alert, ScrollView, Share, Text } from "react-native";
import { choose, confirm, prompt, Row, SectionTitle } from "@/components/ui";
import { api, errorMessage, useOnline } from "@/lib/api";
import { cacheStatus, clearCache, pendingDrafts, kvSet } from "@/lib/doc-store";
import { keys } from "@/lib/queries";
import {
  sqlOf,
  useAccount,
  useCachedQuery,
  useSession,
  useWorkspace,
} from "@/lib/session";
import { exportDrafts, useSignOut } from "@/lib/sign-out";
import {
  colors,
  setThemePreference,
  useThemePreference,
  type ThemePreference,
  useThemeScheme,
} from "@/lib/theme";

const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
};
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default function Settings() {
  useThemeScheme();
  const theme = useThemePreference();
  const qc = useQueryClient();
  const online = useOnline();
  const account = useAccount();
  const sql = sqlOf(account);
  const { signOutAndWipe } = useSession();
  const signOut = useSignOut();
  const { current } = useWorkspace();
  const ws = current?.id ?? "";
  const manage = can(current?.role, "manage_members");
  const members = useCachedQuery(
    keys.members(ws),
    null,
    () => api.members(ws).then((r) => r.members),
    { enabled: !!ws },
  );
  const invitations = useCachedQuery(
    keys.invitations(ws),
    null,
    () => api.invitations(ws).then((r) => r.invitations),
    { enabled: !!ws && manage },
  );
  const grants = useCachedQuery(keys.grants, null, () =>
    api.agentGrants().then((r) => r.grants),
  );
  const local = useQuery({
    queryKey: ["local-cache", account.dbName],
    queryFn: () => cacheStatus(sql),
    networkMode: "always",
    staleTime: 0,
  });

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      Alert.alert(label, errorMessage(err));
    }
  };

  const editMember = async (m: MemberInfo) => {
    const action = await choose(m.name || m.email, [
      ...ROLES.filter((r) => r !== m.role).map((r) => ({
        label: `Make ${ROLE_LABEL[r].toLowerCase()}`,
        value: r as string,
      })),
      {
        label:
          m.userId === account.user.id
            ? "Leave workspace"
            : "Remove from workspace",
        value: "remove",
        destructive: true,
      },
    ]);
    if (!action) return;
    if (action === "remove") {
      if (
        !(await confirm(
          `Remove ${m.name || m.email}?`,
          "They lose access to every page in this workspace immediately.",
          "Remove",
        ))
      )
        return;
      await run("Couldn't remove member", () => api.removeMember(ws, m.userId));
    } else
      await run("Couldn't change role", () =>
        api.updateMember(ws, m.userId, action as Role),
      );
    void qc.invalidateQueries({ queryKey: keys.members(ws) });
    void qc.invalidateQueries({ queryKey: ["me"] });
  };

  const invite = async () => {
    const email = (
      await prompt({
        title: "Invite by email",
        message: "They must sign in with this address to accept.",
        placeholder: "name@example.com",
        keyboardType: "email-address",
        confirm: "Next",
      })
    )?.trim();
    if (!email) return;
    const role = await choose(
      `Invite ${email} as…`,
      ROLES.map((r) => ({ label: ROLE_LABEL[r], value: r })),
    );
    if (!role) return;
    await run("Couldn't create the invitation", async () => {
      const { url } = await api.invite(ws, email, role);
      void qc.invalidateQueries({ queryKey: keys.invitations(ws) });
      const how = await choose(
        "Invitation link created",
        [
          { label: "Share link…", value: "share" as const },
          { label: "Copy link", value: "copy" as const },
        ],
        `Send this single-use link to ${email}.`,
      );
      if (how === "share")
        await Share.share({
          message: `Join ${current?.name ?? "our workspace"}: ${url}`,
          url,
        });
      else if (how === "copy") await Clipboard.setStringAsync(url);
    });
  };

  const clear = async () => {
    const drafts = await pendingDrafts(sql);
    if (
      !(await confirm(
        "Clear offline cache?",
        `Pages saved for offline use are removed from this device${drafts.length ? `. ${drafts.length} page(s) with unsynced edits are kept` : ""}.`,
        "Clear cache",
      ))
    )
      return;
    await clearCache(sql);
    qc.clear();
    void local.refetch();
  };

  const deleteAccount = async () => {
    if (
      !(await confirm(
        "Delete your account?",
        "Your account, sessions, agent connections and memberships are deleted permanently, and this device is signed out. Pages you created stay with their workspaces. If you're a workspace's only owner, transfer ownership first. This can't be undone.",
        "Delete account",
      ))
    )
      return;
    await run("Couldn't delete your account", async () => {
      await api.deleteAccount();
      await signOutAndWipe();
    });
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.grouped }}
      contentContainerStyle={{ paddingBottom: 40 }}
    >
      <SectionTitle>Appearance</SectionTitle>
      <Row
        title="Theme"
        detail={
          theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light"
        }
        onPress={() =>
          void choose<ThemePreference>("Theme", [
            { label: "System", value: "system" },
            { label: "Light", value: "light" },
            { label: "Dark", value: "dark" },
          ]).then((v) => {
            if (v) {
              setThemePreference(v);
              void kvSet(sql, "pref:theme", v);
            }
          })
        }
      />
      <SectionTitle>Account</SectionTitle>
      <Row
        title={account.user.name || account.user.email}
        subtitle={account.user.email}
      />

      {!!ws && (
        <>
          <SectionTitle>{`Members of ${current?.name ?? "workspace"}`}</SectionTitle>
          {members.isPending && <Row title="Loading members…" />}
          {members.isError && (
            <Row
              title="Couldn't load members"
              subtitle={errorMessage(members.error)}
            />
          )}
          {members.data?.map((m) => (
            <Row
              key={m.userId}
              title={`${m.name || m.email}${m.userId === account.user.id ? " (you)" : ""}`}
              subtitle={m.email}
              detail={ROLE_LABEL[m.role]}
              disabled={!online}
              onPress={manage ? () => void editMember(m) : undefined}
              accessibilityHint={manage ? "Change role or remove" : undefined}
            />
          ))}
          {manage && (
            <Row
              title="Invite people…"
              disabled={!online}
              accessibilityHint={
                online
                  ? "Creates a single-use invitation link"
                  : "Needs a connection"
              }
              onPress={() => void invite()}
              testID="invite-people"
            />
          )}
          {manage &&
            invitations.data
              ?.filter((i) => i.status === "pending")
              .map((i) => (
                <Row
                  key={i.id}
                  title={i.email}
                  subtitle={`Invited as ${ROLE_LABEL[i.role].toLowerCase()} · expires ${new Date(i.expiresAt).toLocaleDateString()}`}
                  detail="Pending"
                  disabled={!online}
                  accessibilityHint="Revoke this invitation"
                  onPress={() =>
                    void confirm(
                      "Revoke invitation?",
                      `The link sent to ${i.email} stops working.`,
                      "Revoke",
                    ).then(
                      (ok) =>
                        void (
                          ok &&
                          run("Couldn't revoke", () =>
                            api
                              .revokeInvitation(ws, i.id)
                              .then(() =>
                                qc.invalidateQueries({
                                  queryKey: keys.invitations(ws),
                                }),
                              ),
                          )
                        ),
                    )
                  }
                />
              ))}
        </>
      )}

      <SectionTitle>Agent connections</SectionTitle>
      {grants.isError && (
        <Row
          title="Couldn't load connections"
          subtitle={errorMessage(grants.error)}
        />
      )}
      {grants.data?.length === 0 && <Row title="No AI agents are connected" />}
      {grants.data?.map((g) => (
        <Row
          key={g.id}
          title={g.clientName}
          subtitle={`${g.workspaceName} · ${g.scopes.map((s) => s.replace("workspace:", "")).join(", ")}${g.lastUsedAt ? ` · used ${new Date(g.lastUsedAt).toLocaleDateString()}` : ""}`}
          detail="Revoke"
          disabled={!online}
          onPress={() =>
            void confirm(
              `Disconnect ${g.clientName}?`,
              "It immediately loses access to this workspace.",
              "Revoke",
            ).then(
              (ok) =>
                void (
                  ok &&
                  run("Couldn't revoke", () =>
                    api
                      .revokeAgentGrant(g.id)
                      .then(() =>
                        qc.invalidateQueries({ queryKey: keys.grants }),
                      ),
                  )
                ),
            )
          }
        />
      ))}

      <SectionTitle>Offline storage</SectionTitle>
      <Row
        title="Saved on this device"
        subtitle={
          local.data
            ? `${local.data.docs} pages · ${mb(local.data.bytes)} · ${local.data.entries} cached lists`
            : "…"
        }
        detail={
          local.data?.drafts ? `${local.data.drafts} unsynced` : undefined
        }
        testID="cache-status"
      />
      {!!local.data?.drafts && (
        <Row
          title="Export unsynced drafts…"
          onPress={() =>
            void pendingDrafts(sql).then((d) => exportDrafts(sql, d))
          }
        />
      )}
      <Row
        title="Clear offline cache"
        accessibilityHint="Keeps pages with unsynced edits"
        onPress={() => void clear()}
      />
      <Text
        style={{
          paddingHorizontal: 16,
          paddingTop: 6,
          fontSize: 13,
          color: colors.secondaryLabel,
        }}
      >
        Up to 20 recently opened pages (50 MB) are kept for offline use. Mounted
        pages and pages with unsynced edits are never removed.
      </Text>

      <SectionTitle>Session</SectionTitle>
      <Row
        title="Sign out"
        destructive
        onPress={() => void signOut()}
        testID="sign-out"
      />
      <Row
        title="Delete account…"
        destructive
        disabled={!online}
        accessibilityHint={
          online ? "Permanently deletes your account" : "Needs a connection"
        }
        onPress={() => void deleteAccount()}
      />
    </ScrollView>
  );
}
