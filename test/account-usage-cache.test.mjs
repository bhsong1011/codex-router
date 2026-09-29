import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ACCOUNT_USAGE_TTL_MS, cachedAccountUsage } from "../src/account-usage-cache.mjs";

function tempCache() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "account-usage-cache-"));
  return { dir, cachePath: path.join(dir, "account-usage-cache.json") };
}

test("a read inside the TTL is served from cache, so no app-server is spawned", async () => {
  const { dir, cachePath } = tempCache();
  let calls = 0;
  const read = async () => ({ call: (calls += 1) });
  try {
    const first = await cachedAccountUsage({ cachePath, read, now: 1_000 });
    const second = await cachedAccountUsage({
      cachePath,
      read,
      now: 1_000 + ACCOUNT_USAGE_TTL_MS - 1,
    });
    assert.deepEqual([first, second], [{ call: 1 }, { call: 1 }]);
    assert.equal(calls, 1, "the cache must serve every read inside the TTL");

    const third = await cachedAccountUsage({
      cachePath,
      read,
      now: 1_000 + ACCOUNT_USAGE_TTL_MS + 1,
    });
    assert.deepEqual(third, { call: 2 }, "an expired entry must be refetched");
    assert.equal(calls, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed live read falls back to the stale reading", async () => {
  const { dir, cachePath } = tempCache();
  try {
    await cachedAccountUsage({ cachePath, read: async () => ({ value: "cached" }), now: 1_000 });
    const value = await cachedAccountUsage({
      cachePath,
      read: async () => {
        throw new Error("signed out");
      },
      now: 1_000 + ACCOUNT_USAGE_TTL_MS * 10,
    });
    assert.deepEqual(value, { value: "cached" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with nothing cached the failure is surfaced", async () => {
  const { dir, cachePath } = tempCache();
  try {
    await assert.rejects(
      cachedAccountUsage({
        cachePath,
        read: async () => {
          throw new Error("signed out");
        },
      }),
      /signed out/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
