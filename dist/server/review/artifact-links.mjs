import path from "node:path";
import { artifactAddress, artifactLocation, artifactPathOf, locationArtifact, WORKSPACE_SCOPE } from "../workflow/artifact-paths.mjs";

// Links in a store artifact are mostly written for the paths a checkout gives artifacts, so each relative link is resolved against the artifact's store location first
// and then through its checkout path, mapped back to a store location of the same scope or else the workspace scope, or to a code file of the artifact's repository.

// A link as the review page's Markdown renderer (public/views/markdown.js) renders it: [label](target), with no space in the target, and never an image, ![alt](target).
// The renderer and this extraction agree on what is a link, so every link the page shows comes resolved from the server.
const LINK = /(!?)\[([^\]]+)\]\(([^)\s]+)\)/g;
// A fence opens with three or more backticks or tildes and closes on a line that starts with the same character, as the renderer reads it.
const FENCE = /^(`{3,}|~{3,})/;
// A link with a scheme, a protocol-relative or root path, or only an anchor is no link relative to the artifact.
const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

// The path a link names without its anchor and query, decoded where it is percent-encoded, or null when nothing is left.
function linkPath(href) {
  const bare = href.split("#")[0].split("?")[0];
  if (!bare) return null;
  try { return decodeURIComponent(bare); }
  catch { return bare; }
}

// A path joined to a folder and normalized, or null when it climbs above the root.
function joined(folder, target) {
  const normalized = path.posix.normalize(path.posix.join(folder, target));
  return normalized === "." || normalized === ".." || normalized.startsWith("../") ? null : normalized;
}

/** The relative Markdown links of a text in order, as { line, href }, with line counted from 1; links inside fenced code blocks and inline code are left out. */
export function markdownLinks(content) {
  const links = [];
  let fence = null;
  String(content ?? "").split(/\r?\n/).forEach((text, index) => {
    const marker = text.trim().match(FENCE);
    if (marker) {
      fence = fence === null ? marker[1][0] : fence === marker[1][0] ? null : fence;
      return;
    }
    if (fence !== null) return;
    for (const [, image, , href] of text.replace(/`[^`]+`/g, (code) => " ".repeat(code.length)).matchAll(LINK)) {
      if (!image && !NOT_RELATIVE.test(href) && !href.startsWith("//")) links.push({ line: index + 1, href });
    }
  });
  return links;
}

/** The project-relative path that a checkout configured by kinds gives a store artifact address, or null when it configures none for the kind or the path names another kind. */
export function checkoutPathOf(kinds, { kind, rest }) {
  const file = artifactPathOf(kinds, kind, rest);
  if (file === null) return null;
  const address = artifactAddress(kinds, file);
  return address?.kind === kind && address.rest === rest ? file : null;
}

/** The code-repository ref of a file, code:<repository>:<path>. */
export const codeRefOf = (repository, file) => `code:${repository}:${file}`;

/** The repository and path that a code-repository ref names, or null when it is no such ref. */
export function parseCodeRef(ref) {
  const match = /^code:([^:/]+):(.+)$/.exec(typeof ref === "string" ? ref : "");
  return match ? { repository: match[1], path: match[2] } : null;
}

/**
 * The links of a store artifact's text as { line, href, target, resolved }, with target store:<location> of the artifact the link names, code:<repository>:<path> of the code file it names, or null:
 * location is the artifact's location below artifacts/, kinds the configured artifact kinds of a checkout of its repository, or Prism's default paths, and has(location) whether the store holds an artifact there;
 * repository is the code repository of the artifact's scope, or null when the page reads through no checkout for the workspace scope, and sources the review sources that registered checkouts of it list, or null when none is registered.
 * A link resolves against the location first, and then through the artifact's checkout path, to a location of the artifact's own scope or else the workspace scope,
 * or, for a path the kinds give no artifact kind, to a code file: resolved when a checkout lists it, and resolved null with reason code_not_available when no checkout of the repository is registered.
 */
export function resolveLinks({ content, location, kinds, has, repository = null, sources = null }) {
  const artifact = locationArtifact(location);
  const own = artifact ? checkoutPathOf(kinds, artifact) : null;
  return markdownLinks(content).map(({ line, href }) => {
    const found = resolveLink(href, { location, artifact, own, kinds, has });
    if (found?.store) return { line, href, target: found.store, resolved: true };
    if (found?.code) {
      if (sources === null) return { line, href, target: repository === null ? null : codeRefOf(repository, found.code), resolved: null, reason: "code_not_available" };
      if (sources.has(found.code)) return { line, href, target: codeRefOf(repository, found.code), resolved: true };
    }
    return { line, href, target: null, resolved: false };
  });
}

// What a link names: { store } with the store ref of an artifact, { code } with the checkout path of a file outside every artifact kind, or null.
function resolveLink(href, { location, artifact, own, kinds, has }) {
  const wanted = linkPath(href);
  if (wanted === null) return null;
  const direct = joined(path.posix.dirname(location), wanted);
  if (direct !== null && has(direct)) return { store: `store:${direct}` };
  if (!artifact || own === null) return null;
  const file = joined(path.posix.dirname(own), wanted);
  if (file === null) return null;
  const address = artifactAddress(kinds, file);
  if (!address) return { code: file };
  if (address.rest === "") return null;
  for (const scope of artifact.scope.kind === "workspace" ? [WORKSPACE_SCOPE] : [artifact.scope, WORKSPACE_SCOPE]) {
    const candidate = artifactLocation(scope, address);
    if (has(candidate)) return { store: `store:${candidate}` };
  }
  return null;
}
