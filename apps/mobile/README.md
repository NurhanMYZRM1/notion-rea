# Workspace mobile (iOS + Android)

Expo SDK 58 / React Native 0.88 / Expo Router. Every screen is native (native stack, system colors,
Dynamic Type, ≥44 pt controls) except the page body, which is the shared `@workspace/editor` running in
exactly one DOM component (`components/editor-dom.tsx`, bundled into the app, works offline).

## How it fits together

| Piece | Where |
|---|---|
| Auth: Better Auth Expo client (`expoClient`, scheme `workspace`, SecureStore). Google via system browser, Sign in with Apple (iOS), test login (dev only) — each shown only if `GET /api/providers` says so | `lib/api.ts`, `app/sign-in.tsx` |
| API calls: `@workspace/core` client with `{ Cookie: authClient.getCookie() }`; the OS cookie jar is never used | `lib/api.ts` |
| Session + per-account SQLite DB (`ws-<userId>.db`), metadata cache with offline fallback | `lib/session.tsx` |
| Documents: native `Y.Doc` + `SyncProvider` + SQLite `DocStore` (append resolves after commit; counters persisted; merge >100 rows; LRU 20 docs / 50 MB, never evicts unsynced docs) | `lib/doc-store.ts`, `lib/doc-session.ts` |
| Editor bridge (typed, versioned `v:1`): WebView→native `onBridgeReady`, `onReady`, `onLocalUpdate`, `onAwareness`, `onOpenLink`, `onError`, `pickAndUpload`, `resolveSrc`, `openFile`; native→WebView `applyInit`, `applyRemote`, `applyAwareness`, `setEditable`. Only incremental Yjs/awareness updates cross it; no cookies or tokens | `lib/bridge.ts`, `components/doc-editor.tsx`, `components/editor-dom.tsx` |
| Attachments: native picker, images >2048 px downscaled, `api.upload`; downloads with the cookie into the cache dir, the WebView gets a local URI | `lib/attachments.ts` |
| Workspace events WebSocket (Cookie header) → same query keys as web; full refetch after reconnect | `lib/events.ts`, `lib/queries.ts` |
| Invite links `workspace://invite/<token>` and `https://<host>/invite#<token>` | `app/+native-intent.tsx`, `app/invite/[token].tsx` |

Screens: `app/index.tsx` (home: workspace switcher, Search, Favorites, Recents, lazy page tree),
`search.tsx`, `page/[id]/index.tsx` (pages and database records), `page/[id]/comments.tsx`,
`database/[id].tsx` (table/board, filter, sort, add row), `trash.tsx`, `settings.tsx`, `invite/[token].tsx`.

The WebView is `react-native-webview` (`dom.useExpoDOMWebView: false`) because it is the engine with a
navigation policy hook: the WebView may only (re)load its own document; links open natively (http/https/mailto only).

## Local development

```bash
pnpm install
# backend (separate state dir, port 8787; test login is enabled locally)
cd apps/server
npx wrangler d1 migrations apply DB --local --persist-to ../../.wrangler/mobile-state
# --name avoids sharing miniflare's dev registry entry with another `workspace-dev` instance (crashes on ENOENT)
npx wrangler dev --name workspace-mobile-dev --port 8787 --var PUBLIC_URL:http://localhost:8787 --persist-to ../../.wrangler/mobile-state
node scripts/bootstrap.mjs --email you@example.com --name Team --force --url http://localhost:8787 --state ../../.wrangler/mobile-state

# app (development build; Expo Go is not supported: native modules + react-native-webview policy hooks)
cd apps/mobile
npx expo prebuild --platform ios --clean     # ios/ and android/ are generated (gitignored)
npx expo run:ios                             # or: npx expo run:android
npx expo run:ios --configuration Release     # embedded JS + DOM bundle, no Metro
```

Sign in with "Create test account" using the bootstrap email, then open the printed invitation:
`xcrun simctl openurl booted "workspace://invite/<token>"` (the token is the part after `#`).
Android emulator: the host is `10.0.2.2`, so set `EXPO_PUBLIC_API_URL=http://10.0.2.2:8787`.

`metro.config.js` adds two things to Expo's default: `lib0/webcrypto` → `lib/shims/lib0-webcrypto.js` on native
(lib0's react-native entry needs `isomorphic-webcrypto`; Yjs only needs `getRandomValues`, from expo-crypto), and
a blockList for `.wrangler/` (the watched monorepo root contains the local Worker state).

Timing marks: `[perf] shell-ready` (root layout rendered) and `[perf] open-to-editable` (page screen mount → editor
committed). In Release they are logged at warn level so they reach the system log:
`xcrun simctl spawn booted log stream --predicate 'eventMessage CONTAINS "[perf]"'`.

Checks: `npx tsc -p apps/mobile` and `pnpm --filter mobile test` (node:test with a node:sqlite fake for
the DocStore and the bridge). UI flows for [Maestro](https://maestro.mobile.dev) are in `maestro/`
(sign-in + invite, open page + type, offline edit + relaunch; the offline flow needs the harness to stop the API).

## Environment

| Variable | Used by | Meaning |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | app (build time) | API origin. Default `http://localhost:8787`. Must equal the server's `PUBLIC_URL` origin (WebSocket Origin check). |
| `APP_NAME`, `APP_ID`, `APP_SLUG` | `app.config.ts` | Display name, bundle id / package (default `com.workspace.app`), slug |
| `APP_LINK_HOST` | `app.config.ts` | Host for universal / app links (`https://<host>/invite#…`); adds `associatedDomains` + Android `intentFilters`. The server must serve `apple-app-site-association` / `assetlinks.json` |

Server side for native sign-in: `trustedOrigins` already includes `workspace://`. Sign in with Apple needs
`APPLE_CLIENT_ID`/`APPLE_CLIENT_SECRET` and `APPLE_APP_BUNDLE_IDENTIFIER` = `APP_ID`.

## EAS profiles (`eas.json`)

| Profile | Use |
|---|---|
| `development` | dev client, internal distribution, iOS simulator build, API `http://localhost:8787` |
| `preview` | internal distribution (Android APK), staging API — replace `REPLACE-staging.example.com` |
| `production` | store builds (AAB / IPA), `autoIncrement`, production API — replace `REPLACE.example.com` |

`submit.production` holds placeholders (`appleId`, `ascAppId`, `appleTeamId`, Play service-account key path,
`track: internal`, `releaseStatus: draft`). Build/submit: `eas build -p ios|android --profile production`,
`eas submit -p ios|android --profile production`.

## Store-testing checklist

**Before any store build**
- [ ] Set `APP_ID`, `APP_NAME`, `EXPO_PUBLIC_API_URL` (per profile in `eas.json`), and `APP_LINK_HOST` if invite links should open the app.
- [ ] Production server: `ENVIRONMENT=production` (this disables test login in code), Google and/or Apple configured.
- [ ] iOS: Sign in with Apple is required by App Review whenever Google sign-in is offered — configure Apple on the server.
- [ ] Icons/splash (none are committed yet: add `icon`, `splash`, `android.adaptiveIcon` to `app.config.ts`).

**Google Play — internal testing**
- [ ] `eas build -p android --profile production` → AAB; `eas submit -p android` (track `internal`, draft) or upload in Play Console.
- [ ] Add testers (email list) to the internal testing track; share the opt-in link.
- [ ] Data safety form: use the draft below; declare that data is encrypted in transit and that users can request deletion in-app.
- [ ] App access: provide the review account (below).

**Apple — TestFlight**
- [ ] `eas build -p ios --profile production` → `eas submit -p ios` (fill `ascAppId`, `appleTeamId`).
- [ ] Export compliance: `ITSAppUsesNonExemptEncryption = false` is set (HTTPS only).
- [ ] Internal testers get builds immediately; external testers need Beta App Review (provide the demo account).
- [ ] Privacy manifest: `NSPrivacyTracking = false`; no tracking domains. Required-reason APIs come from Expo/RN pods' own manifests.

**Privacy labels (draft, from `docs/PRIVACY.md` — review before publishing)**
- Contact info: name, email address — linked to the user, app functionality, not tracking.
- User content: pages, database records, comments, photos/files the user uploads — linked, app functionality.
- Identifiers: user id (account) — linked, app functionality.
- Not collected: location, contacts, browsing history, advertising id, diagnostics/crash data, usage analytics.
- On device: recently opened documents and workspace metadata cached in SQLite per account (≤20 docs / 50 MB), deleted on sign-out.
- Photos: the picker is used only when the user adds an image (`NSPhotoLibraryUsageDescription`); no camera or microphone.

**Account deletion (Apple 5.1.1(v), Google Play policy)**
- In app: **Settings → Session → Delete account…** (confirmation dialog; calls `DELETE /api/me`, then wipes local data and signs out).
  Sole owners of a workspace are told to transfer ownership first.
- Provide the same path in the store listing / Play "Delete account URL" (web: Settings → Account → Delete account).

**Review demo account**
- Production has no password login, so review needs a real Google (or Apple) account: create a dedicated
  Google account (e.g. `workspace.review@<your-domain>`), invite it to a demo workspace with sample pages and
  a database, and enter its credentials in App Review Information / Play "App access" with these steps:
  "Tap Continue with Google → sign in with the demo account → open 'Team' → any page."
- Alternatively deploy a review-only staging server with `TEST_LOGIN=enabled` **and** `ENVIRONMENT` ≠ `production`, build
  with the `preview` profile pointing at it, and give reviewers the test email/password. Never enable test login on production.

## Known limits

- Image/file insertion from the editor toolbar does nothing until `packages/editor/src/Editor.tsx` is fixed:
  `CollaborationCaret` gets `provider: { awareness }` without `on/off`, so Tiptap UniqueID's `onCreate` throws and the
  editor's own `onCreate` (which sets the ref `pick()` needs) never runs. The native `pickAndUpload` path is in place.

- Android has not been built or run (no Android SDK on the build machine); the config and code paths are cross-platform.
- Title, favorites, comments, database and member changes need a connection (they are revision-checked REST calls);
  only document bodies are editable offline.
- In debug builds the editor is served by Metro, so images reach the WebView as `data:` URIs; release builds use cached `file://` URIs.
