# Performance plan and results

Targets are acceptance criteria, not claims. A row is "pass" only with a recorded measurement on the
named hardware/profile. Simulator and Lighthouse numbers are kept separately and never count as the
low-end device gate.

## Fixtures

`node scripts/seed-perf.mjs --url <origin> --email <test-login email>` (or `--cookie` against a deployed
environment) creates, in the first workspace of that account:

| Fixture | Shape (measured 2026-10-26, local) |
|---------|------------------------------------|
| Perf · representative | 200 top-level blocks, 10,685 words, 5 images (1600×1000 PNG), 120 KB JSON |
| Perf · stress | 1,000 top-level blocks, 18,900 words, 355 KB JSON |
| Perf · 10k rows | database, 10,000 records, 7 properties (select, number, date, checkbox, url, text) |

## Profiles

| Profile | Device / settings |
|---------|-------------------|
| Android low-mid | Physical Android, 3–4 GB RAM (e.g. Samsung Galaxy A14 / Moto G-class), Android 13+, release build, Wi-Fi |
| iPhone constrained | iPhone SE (2nd gen) or similar, latest supported iOS, release build (TestFlight) |
| Throttled web | Chrome, mobile emulation 412×915, 4× CPU slowdown, "Fast 4G" (9 Mbps / 1.5 Mbps, 60 ms RTT), cache cleared, production deployment |

## How to measure

- **Cold launch (cached workspace)**: force-quit, airplane mode on, launch; time from tap to the
  workspace list rendered (Android: `adb shell am start -W` TotalTime + screen recording; iOS: Xcode
  Instruments "App Launch").
- **Open-to-editable (warm)**: from tapping the representative page to the caret accepting input;
  native: timestamp `onReady` from the editor bridge minus navigation start (logged in dev builds);
  web: Performance mark `page-editable` (set when the editor's `onReady` fires).
- **Typing-to-paint p95**: 200 keystrokes in the representative doc; web: Event Timing API
  (`PerformanceEventTiming` for `keydown` → next paint) from a Playwright script on the throttled
  profile; native: Android `gfxinfo framestats` / iOS Instruments "Animation Hitches" while typing.
- **Scrolling**: 30 s scripted scroll of the stress doc and the 10k-row table; record dropped frames
  (Android `dumpsys gfxinfo`, iOS Instruments Hitches, web Chrome Performance panel).
- **Web vitals**: LCP and CLS from a Playwright run with `web-vitals` on the throttled profile (lab
  data). INP is not claimed; we record interaction latencies from Event Timing instead.
- **Memory**: 20 open → edit → back cycles; record JS heap / RSS before, after, and after GC.

## Results

| Metric | Target | Android low-mid | iPhone constrained | Throttled web | Notes |
|--------|--------|-----------------|--------------------|---------------|-------|
| Cached cold launch | ≤ 3 s | pending (no device) | pending (no device) | n/a | |
| Open-to-editable (warm) | ≤ 1 s | pending | pending | pending | |
| Typing-to-paint p95 | ≤ 100 ms | pending | pending | pending | |
| Scroll dropped frames (30 s) | < 5 % | pending | pending | pending | |
| LCP | ≤ 2.5 s | n/a | n/a | pending | |
| CLS | ≤ 0.1 | n/a | n/a | pending | |
| Initial shell JS (gzip) | ≤ 250 KiB | n/a | n/a | pending | from `vite build` |
| 20 open/edit/back cycles | no crash, no unbounded growth | pending | pending | pending | |

## Server-side (local workerd, not production)

| Measurement | Result |
|-------------|--------|
| `POST /api/databases/:id/query` 10k rows, limit 50, no filter | 9 ms |
| same, select filter + numeric sort desc | 11 ms |
| Page through all 10,000 rows (limit 200) | 10,000 rows returned over 50 requests, 3 s total (uniqueness checked in server tests) |
