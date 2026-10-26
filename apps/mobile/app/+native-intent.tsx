import { inviteTokenFrom } from "@/lib/links";

/** Rewrites `https://<host>/invite#<token>` (token lives in the fragment, which routing drops) to `/invite/<token>`. */
export function redirectSystemPath({
  path,
}: {
  path: string;
  initial: boolean;
}): string {
  try {
    const token = inviteTokenFrom(path);
    return token ? `/invite/${encodeURIComponent(token)}` : path;
  } catch {
    return path;
  }
}
