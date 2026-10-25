import type { ConfigContext, ExpoConfig } from "expo/config";

// All identity is env-driven so store builds can use real identifiers without code changes.
const APP_NAME = process.env.APP_NAME ?? "Workspace";
const APP_ID = process.env.APP_ID ?? "com.workspace.app";
/** Host serving https://<host>/invite#<token> (universal / app links). Optional. */
const LINK_HOST = process.env.APP_LINK_HOST;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: APP_NAME,
  slug: process.env.APP_SLUG ?? "workspace",
  scheme: "workspace",
  version: "1.0.0",
  orientation: "default",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: APP_ID,
    supportsTablet: true,
    usesAppleSignIn: true,
    config: { usesNonExemptEncryption: false },
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
    privacyManifests: { NSPrivacyTracking: false, NSPrivacyTrackingDomains: [] },
    ...(LINK_HOST ? { associatedDomains: [`applinks:${LINK_HOST}`] } : {}),
  },
  android: {
    package: APP_ID,
    ...(LINK_HOST
      ? {
          intentFilters: [
            { action: "VIEW", autoVerify: true, data: [{ scheme: "https", host: LINK_HOST, pathPrefix: "/invite" }], category: ["BROWSABLE", "DEFAULT"] },
          ],
        }
      : {}),
  },
  plugins: [
    "expo-router",
    "expo-sqlite",
    ["expo-secure-store", { faceIDPermission: false }],
    "expo-apple-authentication",
    "expo-web-browser",
    [
      "expo-image-picker",
      {
        photosPermission: "Workspace uses your photo library only when you choose a photo to add to a page.",
        cameraPermission: false,
        microphonePermission: false,
      },
    ],
    "expo-document-picker",
  ],
  experiments: { typedRoutes: false },
  extra: { router: {} },
});
