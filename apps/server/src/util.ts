export const now = () => Date.now();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function pageUrl(env: Env, pageId: string): string {
  return `${env.PUBLIC_URL}/p/${pageId}`;
}

/** Structured log line without page bodies, tokens or codes. */
export function log(event: string, fields: Record<string, string | number | boolean | null | undefined> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
