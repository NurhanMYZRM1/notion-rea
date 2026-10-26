# Workspace UI and hierarchy upgrade

Implemented the approved Notion-style workspace refresh across web, Tauri, iOS and Android,
with real inline subpages, database-record subpages, and an expandable hierarchy map.

## Delivered

- Shared light/dark palette, system appearance, outline icons and consistent controls.
- Resizable desktop sidebar, page tree, breadcrumbs, document layout, database views,
  Search, comments, Settings, members, invitations and Trash.
- Mobile page headers, breadcrumbs, formatting toolbar and Page block picker.
- `/page`, the mobile Page picker and navigation create real children. Creation waits for
  acknowledgement of parent edits before sending its stable block anchor.
- Live page titles/icons; rename, move, archive and restore update documents, navigation and Graph.
- Deleting an owning page block archives its subtree and offers Undo. Duplicate/cut and
  relationship-changing block transforms are guarded.
- Graph uses shared D3 layout, SVG, lazy paginated metadata, records, pan/zoom/Fit,
  search and ancestor focus, accessible tree, Open, New subpage/New record and Move to.
- D1 relationships remain authoritative. Durable trigger outbox projects owning page blocks
  immediately, retries on document reads and uses a one-minute Cloudflare scheduled retry.
  Existing relationships backfill without replacing content; local development drains through
  immediate processing and reads unless scheduled events are explicitly simulated.
- Schema 2 and mobile bridge 2 prevent unsupported clients from editing owning blocks.
  Credentials stay native; mounted documents are pinned against cache eviction.
- Creation retries retain the same account-scoped ID and anchor after a lost response/relaunch.
- Atomic guards prevent stale owning-block deletion, concurrent move cycles and creation under
  a parent that concurrently enters Trash.

## Data protection and rollout

Before migration, 199 local SQLite databases were backed up with SQLite's online backup API to
`.local/backups/notion-ui-2026-10-26/`. Migration `0004_subpages.sql` was applied to the local
`.wrangler/state` database. No remote migrations or deployments were performed.

Existing text and block IDs are retained; missing owning blocks are appended. Old editor sockets
are closed with an upgrade-required response before receiving unsupported blocks. For a future
hosted rollout, deploy compatible clients and server readers before enabling creation/backfill.

## Run and build artifacts

- Installed macOS app: `/Users/nurhanfawwaz/Applications/Workspace.app` (version 0.2.0).
- Android development APK: `.local/artifacts/Workspace-Android-Development.apk`.
- iOS Simulator development build: `.local/artifacts/Workspace-iOS-Simulator-Development.zip`.
- Archive integrity and SHA-256 checks: `.local/artifacts/SHA256SUMS.txt`.

The desktop app starts/reuses this checkout's local server. Keep the checkout, Node and pnpm
in place. Exports and attachment downloads go to the app's Exports folder; **File → Show Exports
Folder** opens it. Filenames are bounded, Unicode-aware and protected against collisions.

Mobile artifacts are development clients and load the current code from Metro. The iOS archive
is a Simulator build. It is not a signed physical-device IPA.

From the repository root:

```sh
pnpm --dir apps/web dev --host 0.0.0.0
EXPO_PUBLIC_API_URL=http://localhost:5173 pnpm --dir apps/mobile start --dev-client --localhost --port 8081
EXPO_PUBLIC_API_URL=http://localhost:5173 pnpm --dir apps/mobile start --dev-client --lan --port 8082
```

Android uses `adb reverse tcp:5173 tcp:5173` and `adb reverse tcp:8082 tcp:8082`, preserving
same-origin WebSocket authorization. Native rebuild helpers are in `apps/mobile/scripts/`.
The iOS helper compiles matching React Native/Hermes sources and handles the checkout's spaces.
Android tooling installed: JDK 21, SDK/build tools, NDK and API 36 emulator image.

## Visual references and measurements

- [Desktop reference](https://mobbin.com/screens/a7c67122-92ad-48b5-aae6-38c53b3edf8b)
- [Mobile reference](https://mobbin.com/screens/23ebacc5-4ddd-4afc-ae8e-3a07063e80cd)
- [Subpage behavior](https://www.notion.com/help/create-a-subpage)

Desktop measurements: 240 px default sidebar, 45 px header, 40 px page title, 16 px document copy,
4/8/12/16/24 px spacing and approximately 708 px document text width. Mobile uses compact native
headers, a 32 px title and accessible touch targets. Comparison screenshots for both desktop
appearances are retained in `.local/artifacts/`. This is a reference-based visual comparison,
not a claim of pixel-identical rendering on every device.

## Verification

| Check | Result |
| --- | --- |
| Server/domain/security/integration | 236 tests passed |
| Shared core/sync/layout | 21 tests passed |
| Shared editor/schema/ownership | 9 tests passed |
| Mobile bridge/cache/retry | 16 tests passed |
| Tauri URL/health/export safety | 8 tests passed |
| Browser acceptance | 24 distinct scenarios passed; 23-test full run plus attachment/export scenario |
| TypeScript and lint | Passed across the workspace |
| Web production build | Passed |
| Rust format, Clippy, tests and macOS bundle | Passed |
| iOS development build | Compiled, installed and launched on iPhone 17 Pro Simulator |
| Android development build | Compiled, installed and launched on API 36 emulator |

Browser checks cover parent/child/grandchild creation, database-record subpages, Trash/Undo,
move into a record, lost-response retry across reload, live ancestor breadcrumbs, remote Trash,
viewer restrictions, collaboration, offline relaunch/drafts, attachments, Markdown export,
database filtering/sorting/boards, light/dark contrast, menus and keyboard sidebar resizing.

The hierarchy API was exercised with 10,000 records. The browser graph's 100-record page remains
collapsed until expansion, performs no document-body fetches, exposes pagination and fits all
loaded nodes in the viewport. Long menus were checked in a short viewport.

Tauri native smoke: app relaunch, persisted sign-in, document/subpage navigation, records in Graph,
node actions, Fit, page menus, Markdown export, saved content and Exports folder command.

iOS native smoke: sign-in, Home/Graph/tree, lazy records, record action restrictions, record-child
creation and rename, mobile Page picker creating a grandchild, internal navigation, breadcrumbs,
keyboard toolbar and acknowledged sync. Maestro flows and screenshots are under
`apps/mobile/test-results/native/ios/`.

Android native smoke: Home, Graph map/tree, Fit, search-and-focus, light/dark/system appearance,
editor typing and server acknowledgement, Page picker creation, live inline child titles,
internal child navigation, Trash and Undo. An offline edit survived a force quit and relaunch;
it was absent from the server while disconnected and present in the Markdown export after reconnect.
The accessible tree was visually checked at 150% font size, then the emulator's prior font size
was restored. Results are under `apps/mobile/test-results/native/android-final/`.

Android fixes found by the native checks:

- Fabric expects `dataDetectorTypes` as an array; the editor passes `["none"]`.
- The pinned React Native WebView patch installs Expo's initial object before the first inline
  script, preventing intermittent blank editors on cold starts. It uses AndroidX's documented
  [document-start injection](https://developer.android.com/reference/androidx/webkit/WebViewCompat#addDocumentStartJavaScript(android.webkit.WebView,java.lang.String,java.util.Set%3Cjava.lang.String%3E))
  when supported and retains the upstream fallback. Credentials remain native.
- The Android build helper refreshes generated autolinking metadata so native patches compile
  from the installed package rather than a stale pnpm store path.

Evidence retained in `.local/artifacts/`: desktop light/dark comparisons, iOS inline grandchild,
Android light/dark maps, accessible tree at 150%, and offline relaunch/reconnect screenshots.
The replacement Android APK includes the native startup fix; both mobile archives pass CRC checks
and have current SHA-256 hashes.

## Delivery review

Final review separates tested behavior from distribution and accessibility limits. Development
builds require the local server and Metro. Full physical-device coverage and a complete manual
VoiceOver/TalkBack spoken-output audit are not claimed by these development checks.

Self-evaluation: the implemented features and local development builds are usable, with the
remaining limits stated above.

| Axis | Score | Evidence and improvement |
| --- | --- | --- |
| Accuracy | 4/5 | 290 unit/integration checks and 24 browser scenarios passed, plus native evidence; physical-device behavior remains unmeasured. |
| Completeness | 4/5 | UI, subpages, hierarchy, reconciliation and all three native builds delivered; complete spoken-output accessibility coverage remains a follow-up. |
| Clarity | 4/5 | Run commands, artifacts and verification limits are explicit; a short first-run walkthrough would make onboarding easier. |
| Actionability | 4/5 | macOS app is installed and mobile development archives are available; mobile clients require the documented Metro setup. |
| Conciseness | 4/5 | User handover is brief and detailed evidence lives here; build details could move into a separate release guide. |

Overall: **4.0/5**. Highest-impact improvements for a release are a physical-device and spoken
screen-reader audit, a signed standalone distribution, and a short first-run walkthrough.
Would the user agree with this assessment? The installed app and reproducible evidence support it;
acceptance of the visual match still benefits from the user's own hands-on review.
