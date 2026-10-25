#!/usr/bin/env node
// Creates the benchmark fixtures in a workspace:
//   1. "Perf · representative": 200 mixed blocks, ~10,000 words, 5 images (1600×1000 PNG)
//   2. "Perf · stress": 1,000 blocks
//   3. "Perf · 10k rows": database with 10,000 records (via CSV import)
// Usage (local, test login enabled):
//   node scripts/seed-perf.mjs --url http://localhost:5173 --email perf@example.test --workspace ws_…
// Against a deployed env pass --cookie "<session cookie>" instead of --email.
import { deflateSync } from "node:zlib";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: { url: { type: "string", default: "http://localhost:5173" }, email: { type: "string" }, cookie: { type: "string" }, workspace: { type: "string" } },
});
const base = o.url.replace(/\/$/, "");
let cookie = o.cookie ?? "";

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { Origin: base, Cookie: cookie, ...(body && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  for (const c of res.headers.getSetCookie?.() ?? []) cookie = [cookie, c.split(";")[0]].filter(Boolean).join("; ");
  return text ? JSON.parse(text) : null;
}

if (!cookie) {
  if (!o.email) throw new Error("--email (local test login) or --cookie required");
  const creds = { email: o.email, password: "perf-fixture-password", name: "Perf" };
  try {
    await call("POST", "/api/auth/sign-up/email", creds);
  } catch {
    await call("POST", "/api/auth/sign-in/email", creds);
  }
}
const me = await call("GET", "/api/me");
const ws = o.workspace ?? me.workspaces[0]?.id;
if (!ws) throw new Error("No workspace: bootstrap one and accept the invite first (see docs/ARCHITECTURE.md)");

const WORDS = "alpha beta gamma delta project roadmap quarterly review design system latency budget customer feedback launch notes metrics owner status draft decision".split(" ");
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const words = (n) => Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" ");

function png(width, height) {
  const crc = (buf) => {
    let c, crcVal = 0xffffffff;
    for (const b of buf) {
      c = (crcVal ^ b) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcVal = (crcVal >>> 8) ^ c;
    }
    return (crcVal ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const i = y * (width * 3 + 1) + 1 + x * 3;
      raw[i] = (x * 255) / width; raw[i + 1] = (y * 255) / height; raw[i + 2] = (rand() * 60 + 120) | 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]));
}

function mixedBlocks(count, wordsPerBlock) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const k = i % 10;
    if (k === 0) out.push(`## Section ${i / 10 + 1}: ${words(4)}`);
    else if (k === 3) out.push(`- ${words(wordsPerBlock / 3)}\n- ${words(wordsPerBlock / 3)}\n- ${words(wordsPerBlock / 3)}`);
    else if (k === 5) out.push(`- [ ] ${words(8)}\n- [x] ${words(8)}`);
    else if (k === 7) out.push(`> ${words(wordsPerBlock)}`);
    else if (k === 8 && i % 20 === 8) out.push("```ts\nconst budget = { lcp: 2500, cls: 0.1 };\nexport default budget;\n```");
    else out.push(`${words(wordsPerBlock)} **${words(3)}** ${words(10)}.`);
  }
  return out;
}

async function pageWith(title, blocks, images = 0) {
  const { page } = await call("POST", `/api/w/${ws}/pages`, { title });
  for (let i = 0; i < images; i++) {
    const body = png(1600, 1000);
    const up = await call("POST", `/api/pages/${page.id}/attachments`, body, { "Content-Type": "image/png", "X-File-Name": `fixture-${i + 1}.png`, "Content-Length": String(body.length) });
    blocks.splice(Math.floor(((i + 1) * blocks.length) / (images + 1)), 0, `![fixture image ${i + 1}](${up.src})`);
  }
  for (let i = 0; i < blocks.length; i += 40) {
    await call("POST", `/api/pages/${page.id}/edit`, { ops: [{ op: "insert", at: { position: "end" }, content: { markdown: blocks.slice(i, i + 40).join("\n\n") } }] });
  }
  return page;
}

const rep = await pageWith("Perf · representative (200 blocks)", mixedBlocks(195, 60), 5);
const stress = await pageWith("Perf · stress (1,000 blocks)", mixedBlocks(1000, 12));
const header = "Name,Status,Estimate,Due,Done,Link,Notes";
const statuses = ["Todo", "Doing", "Done", "Blocked"];
const rows = Array.from({ length: 10_000 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 0, 1 + (i % 365))).toISOString().slice(0, 10);
  return [`Task ${i + 1} ${words(3)}`, statuses[i % 4], (i * 7) % 100, d, i % 3 === 0, `https://example.com/t/${i}`, `"${words(6)}, ${words(2)}"`].join(",");
});
const db = await call("POST", `/api/w/${ws}/import/csv`, { csv: [header, ...rows].join("\n"), title: "Perf · 10k rows", parentId: null });
console.log(JSON.stringify({ workspace: ws, representative: rep.url, stress: stress.url, database: db.database.url, imported: db.imported, rejected: db.rejected.length }, null, 2));
