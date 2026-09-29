import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";

// `codex-router account` spawns a whole `codex app-server` for every read, and
// that spawn is what provokes Codex's marketplace-upgrade leak (see
// marketplace-staging-prune.mjs for the mechanism). The tray asks every 30
// seconds to paint a widget whose windows are five hours and one week long, so
// an answer a minute or two old is still an accurate answer -- and serving it
// costs no process at all.
//
// The cache is a file rather than module state because every caller is its own
// short-lived node process; an in-memory cache would never hit.
export const ACCOUNT_USAGE_TTL_MS = 120_000;

export const ACCOUNT_USAGE_CACHE_PATH = path.join(
  STATE_DIR,
  "account-usage-cache.json",
);

function readCache(cachePath) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    if (typeof parsed?.storedAtMs !== "number") return null;
    return parsed;
  } catch {
    // Absent, truncated, or written by an older shape: treat as a miss.
    return null;
  }
}

function writeCache(cachePath, entry) {
  try {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // A cache that cannot be written is a slower router, not a broken one.
  }
}

export async function cachedAccountUsage({
  cachePath = ACCOUNT_USAGE_CACHE_PATH,
  ttlMs = ACCOUNT_USAGE_TTL_MS,
  now = Date.now(),
  read,
} = {}) {
  if (typeof read !== "function") {
    throw new TypeError("cachedAccountUsage requires a read() function");
  }
  const cached = readCache(cachePath);
  if (cached && now - cached.storedAtMs <= ttlMs) return cached.value;
  let value;
  try {
    value = await read();
  } catch (error) {
    // A status widget is better served by a stale reading than by an error,
    // and this is the path a signed-out or rate-limited account takes.
    if (cached) return cached.value;
    throw error;
  }
  writeCache(cachePath, { storedAtMs: now, value });
  return value;
}
