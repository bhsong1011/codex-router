import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { CODEX_HOME } from "./paths.mjs";

// Codex's marketplace auto-upgrade clones each configured Git marketplace into
// `<CODEX_HOME>/.tmp/marketplaces/.staging/marketplace-upgrade-XXXXXX`, and
// abandons that clone when the app-server which started it exits first: the
// upgrade runs on a detached thread, so neither the git child is killed nor
// the temp-directory destructor runs (openai/codex#47735), and nothing in
// Codex sweeps the directory (#21005).
//
// Codex Router provokes exactly that exit. Reading account usage spawns a
// short-lived `codex app-server`, which is killed as soon as it answers --
// about a second -- while the marketplace clone it started keeps going. Here
// that grew 116G in three days, one full clone per account read.
//
// The writer is what makes an age floor safe: the app-server dies in about a
// second and its orphaned clone finishes within a minute, so anything this old
// cannot still be in flight. This is deliberately not "empty the directory".
export const STALE_STAGING_MS = 10 * 60_000;
export const SWEEP_INTERVAL_MS = 10 * 60_000;

// `marketplace-upgrade-*` and `marketplace-add-*` are the staging names
// upstream documents. Anything else in the directory is left alone.
const MANAGED_PREFIX = "marketplace-";

export function marketplaceStagingRoot(codexHome = CODEX_HOME) {
  return path.join(codexHome, ".tmp", "marketplaces", ".staging");
}

export function pruneMarketplaceStaging({
  root = marketplaceStagingRoot(),
  olderThanMs = STALE_STAGING_MS,
  now = Date.now(),
} = {}) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    // Absent before the first upgrade and after a full sweep. Not an error.
    return { removed: 0, kept: 0 };
  }
  let removed = 0;
  let kept = 0;
  for (const entry of entries) {
    if (!entry.name.startsWith(MANAGED_PREFIX)) {
      kept += 1;
      continue;
    }
    const target = path.join(root, entry.name);
    try {
      if (now - statSync(target).mtimeMs <= olderThanMs) {
        kept += 1;
        continue;
      }
      rmSync(target, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A racing writer, or an entry this process may not remove. Leaving it
      // for the next sweep beats failing the router over someone else's junk.
      kept += 1;
    }
  }
  return { removed, kept };
}

export function startMarketplaceStagingPrune(options = {}) {
  const {
    intervalMs = SWEEP_INTERVAL_MS,
    quiet = process.env.CODEX_ROUTER_QUIET === "1",
    ...prune
  } = options;
  const sweep = () => {
    const { removed } = pruneMarketplaceStaging(prune);
    if (removed && !quiet) {
      process.stderr.write(
        `[codex-router] pruned ${removed} stale marketplace staging ` +
          `director${removed === 1 ? "y" : "ies"}\n`,
      );
    }
    return removed;
  };
  // Once at startup, then on a timer. A sweep is a readdir plus one stat per
  // entry, and the age floor means the directory is usually empty.
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return timer;
}
