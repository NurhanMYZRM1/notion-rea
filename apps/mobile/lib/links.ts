const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;

/** Invitation token from `workspace://invite/<t>`, `/invite/<t>`, `https://host/invite#<t>`, or a bare token. */
export function inviteTokenFrom(input: string): string | null {
  const s = input.trim();
  if (TOKEN.test(s)) return s;
  const m = /(?:^|\/)invite(?:\/|#|\/#)([^/?#\s]+)\/?$/.exec(s);
  const token = m?.[1] ? decodeURIComponent(m[1]) : null;
  return token && TOKEN.test(token) ? token : null;
}
