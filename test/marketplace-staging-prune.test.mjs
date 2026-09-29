import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  pruneMarketplaceStaging,
  startMarketplaceStagingPrune,
} from "../src/marketplace-staging-prune.mjs";

function staged(root, name, ageMs) {
  const target = path.join(root, name);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "marker"), "x");
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(target, when, when);
  return target;
}

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), "marketplace-staging-prune-"));
}

test("pruning removes only abandoned clones past the age floor", () => {
  const root = tempRoot();
  try {
    const old = staged(root, "marketplace-upgrade-old", 20 * 60_000);
    const fresh = staged(root, "marketplace-upgrade-fresh", 0);
    const foreign = staged(root, "something-else", 20 * 60_000);

    assert.deepEqual(pruneMarketplaceStaging({ root }), { removed: 1, kept: 2 });
    assert.equal(existsSync(old), false, "an abandoned clone must go");
    assert.equal(existsSync(fresh), true, "a fresh clone may still be in flight");
    assert.equal(existsSync(foreign), true, "only marketplace staging entries are ours");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an absent staging directory is a miss, not a failure", () => {
  const root = path.join(os.tmpdir(), `marketplace-staging-absent-${process.pid}`);
  assert.deepEqual(pruneMarketplaceStaging({ root }), { removed: 0, kept: 0 });
});

test("the service entry point sweeps immediately", () => {
  const root = tempRoot();
  const old = staged(root, "marketplace-upgrade-old", 20 * 60_000);
  const timer = startMarketplaceStagingPrune({ root, quiet: true, intervalMs: 60_000 });
  try {
    assert.equal(existsSync(old), false);
  } finally {
    clearInterval(timer);
    rmSync(root, { recursive: true, force: true });
  }
});
