#!/usr/bin/env node
// Reads the OpenAI-reported monthly spend limit for a Codex login home.
// The endpoint is workspace-only; personal logins answer 401 and yield {}.
import { readFileSync } from "node:fs";
import path from "node:path";

const home = process.env.CODEX_HOME || path.join(process.env.HOME || "", ".codex");
let tokens;
try {
  tokens = JSON.parse(readFileSync(path.join(home, "auth.json"), "utf8")).tokens;
} catch {
  process.stdout.write("{}\n");
  process.exit(0);
}

const accountId = tokens?.account_id;
const accessToken = tokens?.access_token;
if (!accountId || !accessToken) {
  process.stdout.write("{}\n");
  process.exit(0);
}

try {
  const response = await fetch(
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
  if (!response.ok) {
    process.stdout.write("{}\n");
    process.exit(0);
  }
  const body = await response.json();
  const limit = Number(body?.effective_monthly_limit?.limit);
  const used = Number(body?.current_month_usage);
  if (!Number.isFinite(limit) || !Number.isFinite(used)) {
    process.stdout.write("{}\n");
    process.exit(0);
  }
  process.stdout.write(
    `${JSON.stringify({
      limit,
      used,
      unit: typeof body.balance_unit === "string" ? body.balance_unit : null,
      enforcementMode: body.effective_monthly_limit?.enforcement_mode ?? null,
      limitMode: body.effective_monthly_limit?.limit_mode ?? null,
    })}\n`,
  );
} catch {
  process.stdout.write("{}\n");
}
