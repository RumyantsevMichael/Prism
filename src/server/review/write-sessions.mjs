import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";

// A grant opens one tab that Prism itself opened: valid once and only for this long after issue.
const GRANT_MS = 120 * 1000;
// The shared app keeps the digests of its newest write sessions, so a handoff successor accepts the tabs the person already has.
const KEPT_TOKENS = 100;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const WRITE_SESSIONS_FILE = "write-sessions.json";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const credential = () => randomBytes(32).toString("base64url");

/**
 * The write sessions of one review server or app: one-time grants for the URL Prism opens, exchanged for tokens a tab keeps.
 * Only SHA-256 digests of grants and tokens are held, in memory and, with a directory, in its private file, so no file reveals a credential.
 * restore accepts the digests the directory's file holds, which only an app that starts from a handoff does; any other start begins with none and clears the file.
 */
export async function createWriteSessions({ directory = null, restore = false, now = Date.now } = {}) {
  const grants = new Map();
  let tokens = [];
  const file = directory ? path.join(directory, WRITE_SESSIONS_FILE) : null;
  if (file && restore) {
    const saved = await readFile(file, "utf8").then(parseStoreJson, () => null);
    if (Array.isArray(saved?.tokens)) tokens = saved.tokens.filter((value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)).slice(-KEPT_TOKENS);
  }
  let saving = Promise.resolve();
  function save() {
    if (!file) return saving;
    const text = `${JSON.stringify({ schemaVersion: 1, tokens }, null, 2)}\n`;
    saving = saving.then(() => writeAtomically(file, text, { mode: 0o600 })).catch(() => {});
    return saving;
  }
  await save();

  function sweep() {
    const at = now();
    for (const [key, expiresAt] of grants) if (expiresAt <= at) grants.delete(key);
  }

  return {
    // A new grant for one browser open; the caller adds it to the URL fragment it opens and nowhere else.
    issueGrant() {
      sweep();
      const grant = credential();
      grants.set(digest(grant), now() + GRANT_MS);
      return grant;
    },
    // Consumes a live grant and answers a new token, or null for a used, expired, or unknown grant.
    async exchange(grant) {
      sweep();
      if (typeof grant !== "string" || !TOKEN.test(grant) || !grants.delete(digest(grant))) return null;
      const token = credential();
      tokens = [...tokens, digest(token)].slice(-KEPT_TOKENS);
      await save();
      return token;
    },
    // Whether a token is a live write session of this server or app.
    valid(token) {
      return typeof token === "string" && TOKEN.test(token) && tokens.includes(digest(token));
    }
  };
}

/** The URL that Prism opens: the review URL with the grant in its fragment, which never reaches a server. */
export function withWriteGrant(url, grant) {
  if (!grant) return url;
  const value = new URL(url);
  value.hash = `write=${grant}`;
  return value.href;
}
