import { ApiRequestError } from "@workspace/core";
import { useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Button, Message } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { inviteTokenFrom } from "@/lib/links";
import { pendingInvite, useSession } from "@/lib/session";
import { useSignOut } from "@/lib/sign-out";

type Failure = { title: string; body: string; switchAccount?: boolean; retry?: boolean };

function describe(err: unknown): Failure {
  if (err instanceof ApiRequestError) {
    if (err.code === "network") return { title: "You're offline", body: "Connect to the internet to accept this invitation.", retry: true };
    if (err.code === "forbidden") return { title: "Wrong account", body: err.message, switchAccount: true };
    if (err.code === "gone") return { title: "Invitation can't be used", body: `${err.message}. Ask the person who invited you for a new link.` };
    if (err.code === "not_found" || err.code === "invalid_input") return { title: "Invitation not found", body: "This link is invalid. Check that you opened the whole link, or ask for a new one." };
    if (err.code === "unauthenticated") return { title: "Sign in again", body: "Your session expired.", switchAccount: true };
  }
  return { title: "Couldn't accept the invitation", body: errorMessage(err), retry: true };
}

/** `workspace://invite/<token>` and `https://<host>/invite#<token>` (rewritten in +native-intent) land here. */
export default function Invite() {
  const { token: raw } = useLocalSearchParams<{ token: string }>();
  const token = inviteTokenFrom(raw ?? "");
  const { status, account, selectWorkspace } = useSession();
  const signOut = useSignOut();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  // Remember it across sign-in (and app restarts) until it's accepted or definitively unusable.
  useEffect(() => {
    if (token) void pendingInvite.set(token);
  }, [token]);

  if (!token) return <Message title="Invitation not found" body="This link is invalid." />;

  if (status !== "ready")
    return (
      <>
        <Stack.Screen options={{ title: "Invitation" }} />
        <Message title="You've been invited" body="Sign in with the email address the invitation was sent to, and it will be accepted next.">
          <Button testID="invite-sign-in" title="Sign in to continue" onPress={() => router.replace("/sign-in")} />
        </Message>
      </>
    );

  const accept = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const { workspaceId } = await api.acceptInvitation(token);
      await pendingInvite.clear();
      await qc.invalidateQueries({ queryKey: ["me"] });
      selectWorkspace(workspaceId);
      router.dismissTo("/");
    } catch (err) {
      const f = describe(err);
      if (!f.retry && !f.switchAccount) await pendingInvite.clear();
      setFailure(f);
    } finally {
      setBusy(false);
    }
  };

  // Signing out wipes this account's local data (it must not leak into the other account); drafts are offered for export.
  const switchAccount = async () => {
    if (await signOut()) await pendingInvite.set(token);
  };

  if (failure)
    return (
      <Message title={failure.title} body={failure.body}>
        {failure.retry && <Button title="Try again" busy={busy} onPress={() => void accept()} />}
        {failure.switchAccount && <Button title="Sign out and switch account" onPress={() => void switchAccount()} />}
        <Button
          kind="plain"
          title="Not now"
          onPress={() => {
            void pendingInvite.clear();
            router.dismissTo("/");
          }}
        />
      </Message>
    );

  return (
    <Message title="Join workspace" body={`Accept this invitation as ${account?.user.email ?? "your account"}? You'll get access to the workspace's pages.`}>
      <Button testID="accept-invite" title="Accept invitation" busy={busy} onPress={() => void accept()} />
      <Button
        kind="plain"
        title="Not now"
        onPress={() => {
          void pendingInvite.clear();
          router.dismissTo("/");
        }}
      />
    </Message>
  );
}
