import { ApiRequestError, newId, type PageSummary } from "@workspace/core";
import { api } from "./api";
import { lastUserId } from "./persist";

interface Pending { id:string; afterBlockId?:string }
const pending = new Map<string, Pending>();
const inFlight = new Map<string, Promise<{ page:PageSummary; parentRevision:number }>>();

/** A lost response must reuse the original ID and anchor, including after a relaunch. */
export function createSubpage(parentId:string, afterBlockId?:string) {
  const key = `ws-subpage:${lastUserId() ?? "session"}:${parentId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const run = async () => {
    if (!navigator.onLine) throw new Error("Creating a subpage needs a connection.");
    let request = pending.get(key);
    if (!request) try { const value = JSON.parse(localStorage.getItem(key) ?? "null") as Pending|null; if (value?.id?.startsWith("pg_")) request = value; } catch { /* in-memory fallback */ }
    request ??= { id:newId("pg"), ...(afterBlockId ? { afterBlockId } : {}) };
    pending.set(key, request);
    try { localStorage.setItem(key, JSON.stringify(request)); } catch { /* private mode */ }
    const clear = () => { pending.delete(key); try { localStorage.removeItem(key); } catch { /* private mode */ } };
    try { const response = await api.createSubpage(parentId, request); clear(); return response; }
    catch (err) { if (err instanceof ApiRequestError && err.code !== "network" && err.status < 500) clear(); throw err; }
  };
  const promise = run().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
