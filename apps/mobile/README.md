# Workspace mobile (iOS + Android)

Expo SDK 58 / React Native 0.88 / Expo Router. Every screen is native (native stack, shared neutral light/dark/system palettes,
Dynamic Type, ≥44 pt controls) except the page body, which is the shared `@workspace/editor` running in
exactly one DOM component (`components/editor-dom.tsx`, bundled into the app, works offline).

## How it fits together

| Piece | Where |
|---|---|
| Auth: Better Auth Expo client (`expoClient`, scheme `workspace`, SecureStore). Google via system browser, Sign in with Apple (iOS), test login (dev only) — each shown only if `GET /api/providers` says so | `lib/api.ts`, `app/sign-in.tsx` |
| API calls: `@workspace/core` client with `{ Cookie: authClient.getCookie() }`; the OS cookie jar is never used | `lib/api.ts` |
| Session + per-account SQLite DB (`ws-<userId>.db`), metadata cache with offline fallback | `lib/session.tsx` |
| Documents: native `Y.Doc` + `SyncProvider` + SQLite `DocStore` (append resolves after commit; counters persisted; merge >100 rows; LRU 20 docs / 50 MB, never evicts mounted or unsynced docs) | `lib/doc-store.ts`, `lib/doc-session.ts` |
| Editor bridge (typed, versioned `v:2`): WebView→native `onBridgeReady`, `onReady`, `onLocalUpdate`, `onAwareness`, `onOpenLink`, `onError`, `pickAndUpload`, `resolveSrc`, `openFile`; native→WebView `applyInit`, `applyRemote`, `applyAwareness`, `setEditable`, `refreshPageMetadata`, `setTheme`. Typed child-page resolve/create/open/archive/move actions stay on native. Only incremental Yjs/awareness updates cross it; no cookies or tokens | `lib/bridge.ts`, `components/doc-editor.tsx`, `components/editor-dom.tsx` |
| Attachments: native picker, images >2048 px downscaled, `api.upload`; downloads with the cookie into the cache dir, the WebView gets a local URI | `lib/attachments.ts` |
| Workspace events WebSocket (Cookie header) → same query keys as web; full refetch after reconnect | `lib/events.ts`, `lib/queries.ts` |
| Invite links `workspace://invite/<token>` and `https://<host>/invite#<token>` | `app/+native-intent.tsx`, `app/invite/[token].tsx` |

Screens: `app/index.tsx` (home: workspace switcher, Search, Favorites, Recents, lazy page tree),
`search.tsx`, `graph.tsx` (lazy hierarchy SVG map and accessible tree), `page/[id]/index.tsx` (pages and database records), `page/[id]/comments.tsx`,
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
| `preview` | internal distribution (Android APK), staging API (`https://workspace-staging.paragonxplays.workers.dev`) |
| `production` | store builds (AAB / IPA), `autoIncrement`, production API (`https://workspace.paragonxplays.workers.dev`) |

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

- Development builds were compiled and exercised on an iPhone 17 Pro Simulator and Android API 36 emulator.
  Physical-device and store distribution checks remain separate.
- Title, favorites, comments, database and member changes need a connection (they are revision-checked REST calls);
  only document bodies are editable offline.
- In debug builds the editor is served by Metro, so images reach the WebView as `data:` URIs; release builds use cached `file://` URIs.

Android's pinned `react-native-webview` patch installs Expo's initial object with AndroidX document-start
injection. The upstream asynchronous injection can race the editor's first inline script on cold loads.
The patch affects Android only, retains the navigation policy and keeps credentials on the native side.

## Hierarchy and subpage delivery

The native editor owns the authenticated API and document session. DOM local-update acknowledgements
are drained before `awaitSynced()` and anchored child creation. The server inserts the canonical
`childPage` node. Client-generated IDs are stored in account SQLite until the request succeeds, so
retrying a lost response does not create a second page. Archive offers a navigation-independent Undo.
The bridge and document schema are version 2; older document formats surface an update-required banner.

Graph loads 100 metadata entries per branch, expands records under their databases, caches each
branch per account, and requests ancestor paths for search focus. It never loads document bodies.
The tree alternative exposes full titles, expansion and node actions to assistive technology.

Appearance is saved per account in Settings → Theme. All mounted editor sessions are pinned until
SQLite flush completes, including parent pages retained by the native navigation stack.

Local simulator API origins: iOS `http://localhost:5173`; Android `http://localhost:5173` with `adb reverse tcp:5173 tcp:5173`.
Production EAS origins remain unchanged.

Local native build helpers: `bash scripts/build-local-ios.sh` and
`bash scripts/build-local-android.sh`. The iOS helper compiles matching React Native and Hermes
sources to work around SDK 58 prebuilt ABI mismatches; it needs CMake and Ninja (`brew install cmake ninja`).
Run Metro separately with `EXPO_PUBLIC_API_URL=http://localhost:5173 pnpm start --dev-client --localhost --port 8081`
for iOS, or `EXPO_PUBLIC_API_URL=http://localhost:5173 pnpm start --dev-client --lan --port 8082`
for Android. Android's development client uses `adb reverse tcp:5173 tcp:5173` for the API and `adb reverse tcp:8082 tcp:8082` for Metro. This preserves the local server's WebSocket origin check.
