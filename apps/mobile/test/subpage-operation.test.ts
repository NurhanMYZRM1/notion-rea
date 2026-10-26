import assert from "node:assert/strict";
import { test } from "node:test";
import { submitSubpage } from "../lib/subpage-operation.ts";

test("a lost response retries the same durable page id without creating a duplicate", async () => {
  const storage = new Map<string, string | null>();
  const store = {
    read: async (k: string) => storage.get(k),
    write: async (k: string, v: string | null) => {
      storage.set(k, v);
    },
  };
  const pages = new Set<string>();
  let generated = 0;
  const makeId = () => `pg_${++generated}`;
  await assert.rejects(
    submitSubpage("account", "parent", "anchor", store, makeId, async (id) => {
      pages.add(id);
      throw new Error("lost response");
    }),
    /lost response/,
  );
  const result = await submitSubpage(
    "account",
    "parent",
    "anchor",
    store,
    makeId,
    async (id, anchor) => {
      assert.equal(anchor, "anchor");
      pages.add(id);
      return id;
    },
  );
  assert.equal(result, "pg_1");
  assert.equal(pages.size, 1);
  assert.equal(generated, 1);
  await submitSubpage(
    "account",
    "parent",
    "anchor",
    store,
    makeId,
    async (id) => id,
  );
  assert.equal(
    generated,
    2,
    "a later successful action creates a separate child",
  );
});

test("concurrent clicks share a single pending creation", async () => {
  const store = { read: async () => null, write: async () => {} };
  let requests = 0;
  const request = async (id: string) => {
    requests++;
    return id;
  };
  const a = submitSubpage(
    "other-account",
    "parent",
    undefined,
    store,
    () => "pg_one",
    request,
  );
  const b = submitSubpage(
    "other-account",
    "parent",
    undefined,
    store,
    () => "pg_two",
    request,
  );
  assert.equal(await a, await b);
  assert.equal(requests, 1);
});

test("retrying from a new cursor or sidebar preserves the first operation's anchor", async () => {
  const storage = new Map<string, string | null>();
  const store = {
    read: async (k: string) => storage.get(k),
    write: async (k: string, v: string | null) => {
      storage.set(k, v);
    },
  };
  await assert.rejects(
    submitSubpage(
      "same-account",
      "parent",
      "original-block",
      store,
      () => "pg_original",
      async () => {
        throw new Error("lost response");
      },
    ),
  );
  const result = await submitSubpage(
    "same-account",
    "parent",
    "new-block",
    store,
    () => "pg_duplicate",
    async (id, anchor) => {
      assert.equal(anchor, "original-block");
      return id;
    },
  );
  assert.equal(result, "pg_original");
});
