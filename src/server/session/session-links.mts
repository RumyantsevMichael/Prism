// A session link: the host session behind a claim, recorded only when its host gives a session that a person can open from a link.
// Each kind names one such host and how its link is built, so a host with no openable session records nothing, and adding a host is one entry here.
// The link opens only for the session's owner, so a teammate may see a link that they cannot open.

export type SessionLink = { kind: string; id: string };
type LinkKind = { kind: string; label: string; read: (env: NodeJS.ProcessEnv) => string | null; url: (id: string) => string | null };

const KIND_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// Claude Code on the web names its session cse_<id> in the environment of every process it starts, and opens it at claude.ai/code/session_<id>.
const CLOUD_SESSION = /^cse_([A-Za-z0-9]{8,120})$/;

const KINDS: readonly LinkKind[] = Object.freeze([
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

/** Whether a value is a well-formed session link: an object whose kind and id are each a short plain name; readers keep only those two. */
export function isSessionLink(value: unknown): value is SessionLink {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { kind, id } = value as any;
  return typeof kind === "string" && KIND_PATTERN.test(kind) && typeof id === "string" && ID_PATTERN.test(id);
}

/**
 * The openable session that a server's environment names, or null.
 * A run that Prism launched has none: Prism strips the host session variables from its environment, and its launch already leads to it.
 */
export function environmentSessionLink(env: NodeJS.ProcessEnv = process.env): SessionLink | null {
  if (typeof env.PRISM_LAUNCH === "string" && env.PRISM_LAUNCH) return null;
  for (const entry of KINDS) {
    const id = entry.read(env);
    if (id && ID_PATTERN.test(id)) return { kind: entry.kind, id };
  }
  return null;
}

/** What people see of a session link: { url, label } for a kind this release knows, or null for a malformed link or an unknown kind. */
export function sessionLinkView(value: unknown): { url: string; label: string } | null {
  if (!isSessionLink(value)) return null;
  const entry = KINDS.find((item) => item.kind === value.kind);
  const url = entry?.url(value.id) ?? null;
  return entry && url ? { url, label: entry.label } : null;
}

/** The session field of a claim copy for people: { session } when it leads somewhere, else nothing. */
export const sessionFields = (claim: any) => {
  const session = sessionLinkView(claim?.session);
  return session ? { session } : {};
};

/** The session field of a claim copy that sessionFields already made, kept as it is: { session } when it has a link, else nothing. */
export const keptSession = (claim: any) => (typeof claim?.session?.url === "string" && typeof claim.session.label === "string" ? { session: { url: claim.session.url, label: claim.session.label } } : {});
