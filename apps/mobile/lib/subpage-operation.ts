/** A lost response must reuse both the client id and original anchor, even after an app relaunch. */
export interface SubpageOperationStore {
  read(key: string): Promise<string | null | undefined>;
  write(key: string, value: string | null): Promise<void>;
}
const running = new Map<string, Promise<unknown>>();
export function submitSubpage<T>(
  scope: string,
  parentId: string,
  afterBlockId: string | undefined,
  store: SubpageOperationStore,
  makeId: () => string,
  request: (id: string, originalAnchor?: string) => Promise<T>,
): Promise<T> {
  // Sidebar and editor retries share the pending operation: a server-created child may already have
  // replaced the original empty anchor paragraph by the time the user retries from a new cursor.
  const key = `subpage-operation:${parentId}`;
  const flight = `${scope}:${key}`;
  const existing = running.get(flight);
  if (existing) return existing as Promise<T>;
  const work = (async () => {
    const stored = await store.read(key);
    const operation: { id: string; afterBlockId?: string } = stored
      ? JSON.parse(stored)
      : { id: makeId(), afterBlockId };
    await store.write(key, JSON.stringify(operation));
    const result = await request(operation.id, operation.afterBlockId);
    await store.write(key, null);
    return result;
  })();
  running.set(flight, work);
  void work
    .finally(() => {
      if (running.get(flight) === work) running.delete(flight);
    })
    .catch(() => {});
  return work;
}
