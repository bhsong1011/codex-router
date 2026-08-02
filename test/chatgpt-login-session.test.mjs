import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const home = mkdtempSync(path.join(os.tmpdir(), "chatgpt-login-"));
process.env.CODEX_ROUTER_CHATGPT_LOGIN_HOME = home;

const {
  chatgptLoginRequestHeaders,
  chatgptLoginStatus,
  CHATGPT_LOGIN_AUTH_PATH,
  ensureFreshChatgptLoginToken,
} = await import("../src/chatgpt-login-session.mjs");

function writeAuth(tokens, lastRefresh) {
  writeFileSync(
    CHATGPT_LOGIN_AUTH_PATH,
    `${JSON.stringify({ auth_mode: "chatgpt", tokens, last_refresh: lastRefresh }, null, 2)}\n`,
  );
}

test("reports a configured Personal login and builds account headers", async () => {
  writeAuth(
    { access_token: "acc-token", refresh_token: "ref-token", account_id: "acc-1" },
    new Date().toISOString(),
  );
  assert.equal(chatgptLoginStatus().configured, true);
  assert.equal(chatgptLoginStatus().accountId, "acc-1");
  const session = await ensureFreshChatgptLoginToken();
  const headers = chatgptLoginRequestHeaders(session, { "openai-beta": "responses=v1" });
  assert.equal(headers.Authorization, "Bearer acc-token");
  assert.equal(headers["ChatGPT-Account-Id"], "acc-1");
  assert.equal(headers["openai-beta"], "responses=v1");
});

test("refreshes expired Personal tokens and persists them", async () => {
  writeAuth(
    { access_token: "old-token", refresh_token: "rotating-token", account_id: "acc-1" },
    new Date(Date.now() - 20 * 60 * 1_000).toISOString(),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: "new-token",
      refresh_token: "new-refresh",
      id_token: "new-id",
    }),
  });
  try {
    await ensureFreshChatgptLoginToken({ force: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const auth = JSON.parse(readFileSync(CHATGPT_LOGIN_AUTH_PATH, "utf8"));
  assert.equal(auth.tokens.access_token, "new-token");
  assert.equal(auth.tokens.refresh_token, "new-refresh");
  assert.equal(auth.tokens.account_id, "acc-1");
  assert.equal((await ensureFreshChatgptLoginToken()).accessToken, "new-token");
});
