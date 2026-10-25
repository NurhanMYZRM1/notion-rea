#!/usr/bin/env node
// Throttled mobile-web lab measurement (the "Throttled web" profile in docs/PERFORMANCE.md):
// Chromium, 412×915 mobile emulation, 4× CPU slowdown, "Fast 4G" (9 Mbps down / 1.5 Mbps up, 60 ms RTT).
// Measures on a page URL: LCP, CLS (PerformanceObserver), open-to-editable (navigation → editor focusable),
// and typing-to-paint p95 over N keystrokes (Event Timing: keydown processing start → next paint).
//
//   node scripts/perf-web.mjs --url http://localhost:5173 --page /p/<id> --email perf@example.test --password …
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

// Playwright is a devDependency of apps/web.
const { chromium } = createRequire(new URL("../apps/web/package.json", import.meta.url))("@playwright/test");

const { values: o } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:5173" },
    page: { type: "string" },
    email: { type: "string" },
    password: { type: "string", default: "perf-fixture-password" },
    keys: { type: "string", default: "200" },
    cpu: { type: "string", default: "4" },
  },
});
if (!o.page) throw new Error("--page /p/<id> required");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true });
if (o.email) {
  const res = await context.request.post(`${o.url}/api/auth/sign-in/email`, { data: { email: o.email, password: o.password }, headers: { Origin: o.url } });
  if (!res.ok()) throw new Error(`sign-in ${res.status()}`);
}
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 60, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 });
await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(o.cpu) });

await page.addInitScript(() => {
  window.__perf = { lcp: 0, cls: 0, events: [] };
  new PerformanceObserver((l) => l.getEntries().forEach((e) => (window.__perf.lcp = e.startTime))).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((l) => l.getEntries().forEach((e) => !e.hadRecentInput && (window.__perf.cls += e.value))).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((l) => l.getEntries().forEach((e) => e.name === "keydown" && window.__perf.events.push(e.duration))).observe({ type: "event", durationThreshold: 16, buffered: true });
});

const t0 = Date.now();
await page.goto(`${o.url}${o.page}`, { waitUntil: "domcontentloaded" });
const editor = page.locator(".ws-doc[contenteditable='true']");
await editor.waitFor({ state: "visible", timeout: 60_000 });
const openToEditable = Date.now() - t0;
await page.waitForTimeout(1500);

await editor.click();
await page.keyboard.press("End");
const n = Number(o.keys);
const paints = [];
for (let i = 0; i < n; i++) {
  const start = await page.evaluate(() => performance.now());
  await page.keyboard.type(i % 12 === 11 ? " " : "x");
  paints.push(await page.evaluate((s) => new Promise((r) => requestAnimationFrame(() => setTimeout(() => r(performance.now() - s), 0))), start));
}
const perf = await page.evaluate(() => window.__perf);
const p95 = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] : 0);
const result = {
  profile: { viewport: "412x915", cpuSlowdown: Number(o.cpu), network: "Fast 4G (9/1.5 Mbps, 60 ms)" },
  url: `${o.url}${o.page}`,
  lcpMs: Math.round(perf.lcp),
  cls: Number(perf.cls.toFixed(3)),
  openToEditableMs: openToEditable,
  keystrokes: n,
  typingToPaintP95Ms: Math.round(p95(paints)),
  eventTimingKeydownP95Ms: Math.round(p95(perf.events)),
  eventTimingSamplesOver16ms: perf.events.length,
};
console.log(JSON.stringify(result, null, 2));
await browser.close();
