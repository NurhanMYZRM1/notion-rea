const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Random base62 id with a type prefix, e.g. `pg_3kT9…`. 128 bits of entropy. */
export function newId(prefix: string, length = 22): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 62];
  return `${prefix}_${out}`;
}

export const ID_PATTERN = /^[a-z]{1,4}_[0-9A-Za-z]{8,40}$/;
