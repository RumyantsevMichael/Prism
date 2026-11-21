// Generated from src/server/session/session-links.mts by scripts/native-build/compile.mjs.
const KIND_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CLOUD_SESSION = /^cse_([A-Za-z0-9]{8,120})$/;
const KINDS = Object.freeze([
  {
    kind: "claude-code-web",
    label: "Claude Code on the web",
    read: (env) => {
      const value = typeof env.CLAUDE_CODE_REMOTE_SESSION_ID === "string" ? env.CLAUDE_CODE_REMOTE_SESSION_ID.trim() : "";
      return CLOUD_SESSION.test(value) ? value : null;
    },
    url: (id) => {
      const match = CLOUD_SESSION.exec(id);
      return match ? `https://claude.ai/code/session_${match[1]}` : null;
    }
  }
]);
function isSessionLink(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { kind, id } = value;
  return typeof kind === "string" && KIND_PATTERN.test(kind) && typeof id === "string" && ID_PATTERN.test(id);
}
function environmentSessionLink(env = process.env) {
  if (typeof env.PRISM_LAUNCH === "string" && env.PRISM_LAUNCH) return null;
  for (const entry of KINDS) {
    const id = entry.read(env);
    if (id && ID_PATTERN.test(id)) return { kind: entry.kind, id };
  }
  return null;
}
function sessionLinkView(value) {
  if (!isSessionLink(value)) return null;
  const entry = KINDS.find((item) => item.kind === value.kind);
  const url = entry?.url(value.id) ?? null;
  return entry && url ? { url, label: entry.label } : null;
}
const sessionFields = (claim) => {
  const session = sessionLinkView(claim?.session);
  return session ? { session } : {};
};
const keptSession = (claim) => typeof claim?.session?.url === "string" && typeof claim.session.label === "string" ? { session: { url: claim.session.url, label: claim.session.label } } : {};
export {
  environmentSessionLink,
  isSessionLink,
  keptSession,
  sessionFields,
  sessionLinkView
};
