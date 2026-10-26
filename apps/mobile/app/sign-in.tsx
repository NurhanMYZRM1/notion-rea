import { useQuery } from "@tanstack/react-query";
import * as AppleAuthentication from "expo-apple-authentication";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { Button } from "@/components/ui";
import { api, authClient, errorMessage } from "@/lib/api";
import { useSession } from "@/lib/session";
import { colors, HIT, useThemeScheme } from "@/lib/theme";

export default function SignIn() {
  useThemeScheme();
  const { completeSignIn } = useSession();
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: api.providers,
    retry: 1,
  });
  const [busy, setBusy] = useState<string | null>(null);

  const run =
    (
      name: string,
      fn: () => Promise<{ error?: { message?: string } | null } | void>,
    ) =>
    async () => {
      setBusy(name);
      try {
        const res = await fn();
        if (res && res.error)
          throw new Error(res.error.message ?? "Sign-in failed");
        const cookie = await authClient.getCookie();
        if (!cookie) return; // browser flow cancelled
        await completeSignIn();
      } catch (err) {
        if ((err as { code?: string }).code === "ERR_REQUEST_CANCELED") return;
        Alert.alert("Couldn't sign in", errorMessage(err));
      } finally {
        setBusy(null);
      }
    };

  const p = providers.data;
  const apple = !!p?.apple && Platform.OS === "ios"; // Sign in with Apple is offered on iOS only
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: colors.grouped }}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          padding: 24,
          gap: 16,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{ fontSize: 34, fontWeight: "700", color: colors.label }}
        >
          Workspace
        </Text>
        <Text style={{ fontSize: 17, color: colors.secondaryLabel }}>
          Sign in to open your team's pages and databases.
        </Text>
        {providers.isPending && (
          <ActivityIndicator accessibilityLabel="Loading sign-in options" />
        )}
        {providers.isError && (
          <View style={{ gap: 8 }}>
            <Text selectable style={{ color: colors.danger, fontSize: 15 }}>
              {errorMessage(providers.error)}
            </Text>
            <Button
              kind="plain"
              title="Try again"
              onPress={() => void providers.refetch()}
            />
          </View>
        )}
        {p?.google && (
          <Button
            title="Continue with Google"
            busy={busy === "google"}
            disabled={!!busy}
            accessibilityHint="Opens Google sign-in in the system browser"
            onPress={run("google", () =>
              authClient.signIn.social({
                provider: "google",
                callbackURL: "/",
              }),
            )}
          />
        )}
        {apple && (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={
              AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN
            }
            buttonStyle={
              AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
            }
            cornerRadius={10}
            style={{ height: HIT + 6 }}
            onPress={run("apple", async () => {
              const cred = await AppleAuthentication.signInAsync({
                requestedScopes: [
                  AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
                  AppleAuthentication.AppleAuthenticationScope.EMAIL,
                ],
              });
              if (!cred.identityToken)
                throw new Error("Apple did not return an identity token");
              return authClient.signIn.social({
                provider: "apple",
                idToken: { token: cred.identityToken },
              });
            })}
          />
        )}
        {p && !p.google && !apple && !p.testLogin && (
          <Text
            selectable
            style={{ fontSize: 15, color: colors.secondaryLabel }}
          >
            No sign-in method is configured on this server yet.
          </Text>
        )}
        {p?.testLogin && <TestLogin busy={busy} run={run} />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Local/CI only (the server disables it in production): email + password so tests can sign in without Google. */
function TestLogin({
  busy,
  run,
}: {
  busy: string | null;
  run: (
    name: string,
    fn: () => Promise<{ error?: { message?: string } | null }>,
  ) => () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const field = {
    minHeight: HIT,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 17,
    color: colors.label,
    backgroundColor: colors.card,
  } as const;
  return (
    <View style={{ gap: 10, marginTop: 12 }}>
      <Text
        accessibilityRole="header"
        style={{
          fontSize: 13,
          fontWeight: "600",
          color: colors.secondaryLabel,
          textTransform: "uppercase",
        }}
      >
        Test sign-in (development only)
      </Text>
      <TextInput
        testID="test-email"
        accessibilityLabel="Email"
        placeholder="Email"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="username"
        value={email}
        onChangeText={setEmail}
        style={field}
        placeholderTextColor={colors.tertiaryLabel}
      />
      <TextInput
        testID="test-password"
        accessibilityLabel="Password"
        placeholder="Password (8+ characters)"
        secureTextEntry
        textContentType="password"
        value={password}
        onChangeText={setPassword}
        style={field}
        placeholderTextColor={colors.tertiaryLabel}
      />
      <TextInput
        testID="test-name"
        accessibilityLabel="Name, for new test accounts"
        placeholder="Name (only for a new account)"
        value={name}
        onChangeText={setName}
        style={field}
        placeholderTextColor={colors.tertiaryLabel}
      />
      <Button
        testID="test-sign-in"
        title="Sign in"
        busy={busy === "email"}
        disabled={!!busy || !email || password.length < 8}
        onPress={run("email", () =>
          authClient.signIn.email({ email: email.trim(), password }),
        )}
      />
      <Button
        kind="plain"
        title="Create test account"
        disabled={!!busy || !email || password.length < 8}
        onPress={run("signup", () =>
          authClient.signUp.email({
            email: email.trim(),
            password,
            name: name.trim() || email.split("@")[0]!,
          }),
        )}
      />
    </View>
  );
}
