// The Codex app-server rate-limit read returns only the 5-hour and weekly
// windows. ChatGPT/Codex surfaces also show a workspace monthly spend cap,
// which lives behind the same backend endpoint the desktop app calls.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoveryDisabled } from "./discovery-mode.mjs";

const MONTH_MINUTES = 43_200;

export function normalizeMonthlyUsage(payload) {
  const limit = Number(payload?.effective_monthly_limit?.limit);
  const used = Number(payload?.current_month_usage);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) return null;
  const usedPercent = Math.min(100, Math.max(0, (used / limit) * 100));
  return {
    kind: "quota",
    label: "Monthly limit",
    windowDurationMins: MONTH_MINUTES,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    used,
    limit,
    unit: typeof payload?.balance_unit === "string" ? payload.balance_unit : null,
    enforcementMode: payload?.effective_monthly_limit?.enforcement_mode ?? null,
    resetsAt: null,
  };
}

export function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export async function readCodexMonthlyUsage({
  home = defaultCodexHome(),
  fetchImpl = fetch,
} = {}) {
  if (discoveryDisabled()) return null;
  let tokens;
  try {
    tokens = JSON.parse(readFileSync(path.join(home, "auth.json"), "utf8")).tokens;
  } catch {
    return null;
  }
  const accountId = tokens?.account_id;
  const accessToken = tokens?.access_token;
  if (!accountId || !accessToken) return null;
  try {
    const response = await fetchImpl(
      `https://chatgpt.com/backend-api/accounts/${accountId}/spend-controls/current-user/monthly-usage`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "chatgpt-account-id": accountId,
          "OAI-App-Brand": "codex",
          "cache-control": "no-store",
          pragma: "no-cache",
          accept: "application/json",
        },
      },
    );
    if (!response?.ok) return null;
    return normalizeMonthlyUsage(await response.json());
  } catch {
    return null;
  }
}
