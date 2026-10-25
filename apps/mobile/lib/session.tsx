import { ApiRequestError, type Me } from "@workspace/core";
import { type QueryKey, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { Directory, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import { createContext, type ReactNode, use, useCallback, useEffect, useMemo, useState } from "react";
import { api, authClient, COOKIE_KEYS, isNetworkError } from "./api";
import { kvGet, kvSet, migrate, type Sql } from "./doc-store";

type User = Me["user"];
export interface Account {
  user: User;
  sql: SQLite.SQLiteDatabase;
  dbName: string;
}
type Status = "loading" | "signed-out" | "ready";

interface SessionValue {
  status: Status;
  account: Account | null;
  /** Call after Better Auth stored a session cookie. */
  completeSignIn(): Promise<void>;
  /** Signs out and deletes this account's local database and session. Caller confirms drafts first. */
  signOutAndWipe(): Promise<void>;
  /** Session cookie rejected by the server: back to sign-in, keeping local drafts for this account. */
  expire(): void;
  wsPref: string | null;
  selectWorkspace(id: string): void;
}

const USER_KEY = "ws.user";
const INVITE_KEY = "ws.invite";
const SessionContext = createContext<SessionValue | null>(null);

export const ATTACHMENTS_DIR = () => new Directory(Paths.cache, "attachments");
const dbNameFor = (userId: string) => `ws-${userId.replace(/[^A-Za-z0-9_-]/g, "_")}.db`;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [account, setAccount] = useState<Account | null>(null);
  const [wsPref, setWsPref] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const open = useCallback(async (user: User) => {
    const dbName = dbNameFor(user.id);
    const sql = await SQLite.openDatabaseAsync(dbName);
    await migrate(sql as unknown as Sql);
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
    setWsPref((await kvGet<string>(sql as unknown as Sql, "pref:ws")) ?? null);
    setAccount({ user, sql, dbName });
    setStatus("ready");
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const cookie = await authClient.getCookie();
        if (!cookie) return setStatus("signed-out");
        const saved = await SecureStore.getItemAsync(USER_KEY);
        // Offline cold start: the stored user opens the right local database without the network.
        if (saved) return await open(JSON.parse(saved) as User);
        await open((await api.me()).user);
      } catch {
        setStatus("signed-out");
      }
    })();
  }, [open]);

  const completeSignIn = useCallback(async () => {
    const me = await api.me();
    const prev = await SecureStore.getItemAsync(USER_KEY);
    if (prev && (JSON.parse(prev) as User).id !== me.user.id) queryClient.clear();
    await open(me.user);
  }, [open, queryClient]);

  const signOutAndWipe = useCallback(async () => {
    const acc = account;
    await authClient.signOut().catch(() => {}); // offline: still forget the session locally
    await Promise.all([...COOKIE_KEYS, USER_KEY, INVITE_KEY].map((k) => SecureStore.deleteItemAsync(k).catch(() => {})));
    queryClient.clear();
    setAccount(null);
    setStatus("signed-out");
    if (acc) {
      await acc.sql.closeAsync().catch(() => {});
      await SQLite.deleteDatabaseAsync(acc.dbName).catch((err) => console.warn("delete db failed", err));
    }
    try {
      const dir = ATTACHMENTS_DIR();
      if (dir.exists) dir.delete();
    } catch {
      /* cache dir is OS-managed anyway */
    }
  }, [account, queryClient]);

  const expire = useCallback(() => {
    void Promise.all(COOKIE_KEYS.map((k) => SecureStore.deleteItemAsync(k).catch(() => {})));
    setStatus("signed-out");
  }, []);

  const selectWorkspace = useCallback(
    (id: string) => {
      setWsPref(id);
      if (account) void kvSet(account.sql as unknown as Sql, "pref:ws", id);
    },
    [account],
  );

  const value = useMemo(
    () => ({ status, account, completeSignIn, signOutAndWipe, expire, wsPref, selectWorkspace }),
    [status, account, completeSignIn, signOutAndWipe, expire, wsPref, selectWorkspace],
  );
  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession(): SessionValue {
  const v = use(SessionContext);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}

/** The signed-in account; only valid under screens guarded by status === "ready". */
export function useAccount(): Account {
  const { account } = useSession();
  if (!account) throw new Error("No account");
  return account;
}

export const sqlOf = (a: Account) => a.sql as unknown as Sql;

export class OfflineError extends Error {
  constructor() {
    super("Not available offline");
  }
}

/**
 * Network first; on a network failure fall back to the last copy in the account's SQLite kv table, so
 * the workspace shell stays navigable offline. Uncached data surfaces as OfflineError.
 */
export function useCachedOptions() {
  const account = useAccount();
  const { expire } = useSession();
  return useCallback(
    <T,>(queryKey: QueryKey, kvKey: string | null, fetcher: () => Promise<T>): UseQueryOptions<T> => ({
      queryKey,
      networkMode: "always",
      retry: (n, err) => !(err instanceof OfflineError) && !(err instanceof ApiRequestError && err.status >= 400 && err.status < 500) && n < 2,
      queryFn: async () => {
        const sql = sqlOf(account);
        try {
          const value = await fetcher();
          if (kvKey) void kvSet(sql, kvKey, value).catch(() => {});
          return value;
        } catch (err) {
          if (err instanceof ApiRequestError && err.code === "unauthenticated") expire();
          if (kvKey && isNetworkError(err)) {
            const cached = await kvGet<T>(sql, kvKey);
            if (cached !== undefined) return cached;
            throw new OfflineError();
          }
          throw err;
        }
      },
    }),
    [account, expire],
  );
}

export function useCachedQuery<T>(queryKey: QueryKey, kvKey: string | null, fetcher: () => Promise<T>, opts?: Partial<UseQueryOptions<T>>) {
  const make = useCachedOptions();
  return useQuery<T>({ ...make(queryKey, kvKey, fetcher), ...opts });
}

export function useMe() {
  return useCachedQuery(["me"], "me", api.me);
}

/** Current workspace (persisted per account), defaulting to the first membership. */
export function useWorkspace() {
  const { wsPref, selectWorkspace } = useSession();
  const me = useMe();
  const workspaces = me.data?.workspaces ?? [];
  const current = workspaces.find((w) => w.id === wsPref) ?? workspaces[0] ?? null;
  return { me, workspaces, current, select: selectWorkspace };
}

export const pendingInvite = {
  get: () => SecureStore.getItemAsync(INVITE_KEY),
  set: (token: string) => SecureStore.setItemAsync(INVITE_KEY, token),
  clear: () => SecureStore.deleteItemAsync(INVITE_KEY),
};
