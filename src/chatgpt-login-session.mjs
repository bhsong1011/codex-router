import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { VERSION } from "./version.mjs";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_URL = "https://auth.openai.com/oauth/token";
const REFRESH_THRESHOLD_MS = 10 * 60 * 1_000;
const REFRESH_TIMEOUT_MS = 30_000;

export const CHATGPT_LOGIN_HOME =
  process.env.CODEX_ROUTER_CHATGPT_LOGIN_HOME || path.join(os.homedir(), ".codex-personal");
export const CHATGPT_LOGIN_AUTH_PATH = path.join(CHATGPT_LOGIN_HOME, "auth.json");

let refreshInFlight;

function loginError(message) {
  const error = new Error(message);
  error.code = "oauth_unauthorized";
  error.status = 401;
  return error;
}

function readAuth() {
  try {
    return JSON.parse(readFileSync(CHATGPT_LOGIN_AUTH_PATH, "utf8"));
  } catch {
    return undefined;
  }
}

function readSession() {
  const auth = readAuth();
  const tokens = auth?.tokens;
  if (!auth || !tokens || typeof tokens.access_token !== "string" || !tokens.access_token) {
    return undefined;
  }
  const lastRefresh = typeof auth.last_refresh === "string"
    ? Date.parse(auth.last_refresh)
    : Number.NaN;
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: tokens.account_id,
    lastRefresh,
  };
}

function writeRefreshed(payload, previous) {
  const previousTokens = previous?.tokens || {};
  const tokens = {
    ...previousTokens,
    id_token: payload.id_token ?? previousTokens.id_token,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token ?? previousTokens.refresh_token,
  };
  const next = {
    ...(previous || { auth_mode: "chatgpt" }),
    tokens,
    last_refresh: new Date().toISOString(),
  };
  mkdirSync(CHATGPT_LOGIN_HOME, { recursive: true, mode: 0o700 });
  chmodSync(CHATGPT_LOGIN_HOME, 0o700);
  const temporary = `${CHATGPT_LOGIN_AUTH_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, CHATGPT_LOGIN_AUTH_PATH);
    protectPrivateFile(CHATGPT_LOGIN_AUTH_PATH);
  } catch (error) {
    try {
      if (temporary) unlinkSync(temporary);
    } catch {
      // The original auth.json remains the source of truth.
    }
    throw error;
  }
}

export function chatgptLoginStatus() {
  const session = readSession();
  return {
    configured: Boolean(session),
    home: CHATGPT_LOGIN_HOME,
    ...(session?.accountId ? { accountId: session.accountId } : {}),
  };
}

export async function refreshChatgptLogin({ fetchImpl = fetch } = {}) {
  const session = readSession();
  if (!session) {
    throw loginError(
      "Personal ChatGPT login is unavailable; run `mkdir -p ~/.codex-personal && CODEX_HOME=~/.codex-personal codex login`.",
    );
  }
  if (typeof session.refreshToken !== "string" || !session.refreshToken) {
    throw loginError(
      "Personal ChatGPT refresh token is missing; run `CODEX_HOME=~/.codex-personal codex login` again.",
    );
  }
  const response = await fetchImpl(REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": `codex-router/${VERSION}`,
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload?.access_token !== "string" || !payload.access_token) {
    throw loginError(
      "Personal ChatGPT login could not refresh; run `CODEX_HOME=~/.codex-personal codex login` again.",
    );
  }
  writeRefreshed(payload, readAuth());
  return readSession();
}

export async function ensureFreshChatgptLoginToken({ force = false, now = Date.now() } = {}) {
  const initial = readSession();
  if (!initial) {
    throw loginError(
      "Personal ChatGPT login is unavailable; run `mkdir -p ~/.codex-personal && CODEX_HOME=~/.codex-personal codex login`.",
    );
  }
  if (
    !force &&
    Number.isFinite(initial.lastRefresh) &&
    now - initial.lastRefresh < REFRESH_THRESHOLD_MS
  ) {
    return initial;
  }

  while (refreshInFlight) {
    const session = await refreshInFlight;
    if (!force || session.accessToken !== initial.accessToken) return session;
  }

  refreshInFlight = (async () => {
    try {
      await refreshChatgptLogin();
    } catch (error) {
      const current = readSession();
      if (!force && current) return current;
      throw error;
    }
    return readSession();
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = undefined;
  }
}

export function chatgptLoginRequestHeaders(session, requestHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    "Accept-Encoding": "identity",
    Authorization: `Bearer ${session.accessToken}`,
    "ChatGPT-Account-Id": session.accountId,
  };
  const beta = requestHeaders["openai-beta"];
  if (beta !== undefined) headers["openai-beta"] = beta;
  return headers;
}
