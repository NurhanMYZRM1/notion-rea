import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";

export type Auth = ReturnType<typeof createAuth>;

export function testLoginEnabled(env: Env): boolean {
  return env.ENVIRONMENT !== "production" && env.TEST_LOGIN === "enabled";
}

/** Better Auth identifies people. Workspace membership (D1 `members`) authorizes them. */
export function createAuth(env: Env) {
  const testLogin = testLoginEnabled(env);
  const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET;
  const apple = env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET;
  return betterAuth({
    appName: "Workspace",
    database: env.DB,
    baseURL: env.PUBLIC_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.PUBLIC_URL, "workspace://", ...(env.ENVIRONMENT === "production" ? [] : ["exp://"])],
    socialProviders: {
      ...(google ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, prompt: "select_account" as const } } : {}),
      ...(apple
        ? { apple: { clientId: env.APPLE_CLIENT_ID, clientSecret: env.APPLE_CLIENT_SECRET, appBundleIdentifier: env.APPLE_APP_BUNDLE_IDENTIFIER || undefined } }
        : {}),
    },
    // Local/CI only: lets automated tests sign in without Google. Disabled in production by code.
    emailAndPassword: { enabled: testLogin, autoSignIn: true, minPasswordLength: 8 },
    account: {
      // Never merge identities just because emails match; linking needs an authenticated linkSocial() call.
      accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: false },
    },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    rateLimit: { enabled: env.ENVIRONMENT === "production", window: 60, max: 60 },
    databaseHooks: testLogin
      ? { user: { create: { before: async (user) => ({ data: { ...user, emailVerified: true } }) } } }
      : undefined,
    plugins: [expo()],
  });
}
