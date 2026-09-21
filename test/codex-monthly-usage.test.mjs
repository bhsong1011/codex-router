import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeMonthlyUsage,
  readCodexMonthlyUsage,
} from "../src/codex-monthly-usage.mjs";

test("normalizes the workspace monthly spend cap", () => {
  const metric = normalizeMonthlyUsage({
    balance_unit: "credit",
    effective_monthly_limit: { limit: 7000, enforcement_mode: "HARD_CAP" },
    current_month_usage: 5619.094321370125,
  });
  assert.ok(metric);
  assert.equal(metric.kind, "quota");
  assert.equal(metric.label, "Monthly limit");
  assert.equal(metric.windowDurationMins, 43_200);
  assert.equal(Math.round(metric.remainingPercent), 20);
  assert.equal(metric.unit, "credit");
  assert.equal(metric.enforcementMode, "HARD_CAP");
});

test("omits monthly usage when the account reports no usable cap", () => {
  assert.equal(normalizeMonthlyUsage(null), null);
  assert.equal(normalizeMonthlyUsage({ current_month_usage: 12 }), null);
  assert.equal(
    normalizeMonthlyUsage({ effective_monthly_limit: { limit: 0 }, current_month_usage: 12 }),
    null,
  );
});

test("reads monthly usage for the login home", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "codex-monthly-"));
  writeFileSync(
    path.join(home, "auth.json"),
    JSON.stringify({ tokens: { access_token: "test-token", account_id: "acct-1" } }),
  );
  let requested = null;
  try {
    const metric = await readCodexMonthlyUsage({
      home,
      fetchImpl: async (url, options) => {
        requested = { url, accountHeader: options.headers["chatgpt-account-id"] };
        return {
          ok: true,
          json: async () => ({
            balance_unit: "credit",
            effective_monthly_limit: { limit: 100, enforcement_mode: "HARD_CAP" },
            current_month_usage: 25,
          }),
        };
      },
    });
    assert.match(requested.url, /accounts\/acct-1\/spend-controls\/current-user\/monthly-usage$/);
    assert.equal(requested.accountHeader, "acct-1");
    assert.equal(metric.remainingPercent, 75);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
