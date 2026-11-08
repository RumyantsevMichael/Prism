import { escapeHtml } from "./util.js";

// Known hosts and the web paths of a commit and a branch on them; any other host shows plain text.
const HOSTS = {
  "github.com": { name: "GitHub", commit: (sha) => `commit/${sha}`, branch: (name) => `tree/${name}` },
  "gitlab.com": { name: "GitLab", commit: (sha) => `-/commit/${sha}`, branch: (name) => `-/tree/${name}` },
  "bitbucket.org": { name: "Bitbucket", commit: (sha) => `commits/${sha}`, branch: (name) => `src/${name}` }
};

// A recorded remote as a host path such as github.com/owner/repo, without scheme, user, port, or .git.
export function displayRemote(remote) {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i;
  const plain = scheme.test(remote) ? remote.replace(scheme, "").replace(/^[^@/]+@/, "") : remote.replace(/^[^@/:]+@/, "").replace(":", "/");
  return plain.replace(/\/+$/, "").replace(/\.git$/, "");
}

/** The web home of a recorded remote on a known host: { host, url }, or null. */
export function remoteWeb(remote) {
  if (typeof remote !== "string" || !remote) return null;
  const [hostPort, ...rest] = displayRemote(remote).split("/");
  const host = hostPort.toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
  const parts = rest.filter(Boolean);
  if (!HOSTS[host] || parts.length < 2 || parts.some((part) => part === "." || part === "..")) return null;
  return { host: HOSTS[host], url: `https://${host}/${parts.map(encodeURIComponent).join("/")}` };
}

// The link's name says where it goes and keeps the text it shows.
const link = (href, name, html) => `<a class="code-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(name)}">${html}</a>`;

/** The branch, commit, and repository of a recorded checkout as HTML, linked to the remote's web pages on a known host: { branch, commit, remote }. */
export function codeParts(code) {
  if (typeof code?.head !== "string" || !code.head) return null;
  const web = remoteWeb(code.remote);
  const branchName = typeof code.branch === "string" && code.branch ? code.branch : null;
  const commitHtml = `<code>${escapeHtml(code.head.slice(0, 7))}</code>`;
  const branchHtml = branchName ? escapeHtml(branchName) : null;
  const remoteHtml = typeof code.remote === "string" && code.remote ? escapeHtml(displayRemote(code.remote)) : null;
  if (!web) return { branch: branchHtml, commit: commitHtml, remote: remoteHtml };
  return {
    branch: branchName && link(`${web.url}/${web.host.branch(branchName.split("/").map(encodeURIComponent).join("/"))}`, `Open branch ${branchName} on ${web.host.name}`, branchHtml),
    commit: link(`${web.url}/${web.host.commit(encodeURIComponent(code.head))}`, `Open commit ${code.head.slice(0, 12)} on ${web.host.name}`, commitHtml),
    remote: link(web.url, `Open the repository on ${web.host.name}`, remoteHtml)
  };
}

/** A compact branch · commit label of a recorded checkout for slice lists, or "". */
export function codeChip(code) {
  const parts = codeParts(code);
  if (!parts) return "";
  const title = `Last passing run${code.branch ? ` on ${code.branch}` : ""} at ${code.head.slice(0, 7)}${code.dirty === true ? " with uncommitted changes" : ""}`;
  return `<prism-chip class="code-location" tip="${escapeHtml(title)}">${parts.branch ? `${parts.branch} · ` : ""}${parts.commit}${code.dirty === true ? '<span class="code-dirty" aria-label="with uncommitted changes">*</span>' : ""}</prism-chip>`;
}
