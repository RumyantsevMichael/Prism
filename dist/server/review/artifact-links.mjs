import path from "node:path";
import { artifactAddress, artifactLocation, artifactPathOf, locationArtifact, WORKSPACE_SCOPE } from "../workflow/artifact-paths.mjs";

// Links in a store artifact are mostly written for the paths a checkout gives artifacts, so each relative link is resolved against the artifact's store location first
// and then through its checkout path, mapped back to a store location of the same scope or else the workspace scope.

// A link as the review page renders it: [label](target), with no space in the target.
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
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
    const marker = text.trim().match(/^(`{3,}|~{3,})/);
    if (marker) {
      fence = fence === null ? marker[1][0] : fence === marker[1][0] ? null : fence;
      return;
    }
    if (fence !== null) return;
    for (const match of text.replace(/`[^`]*`/g, (code) => " ".repeat(code.length)).matchAll(LINK)) {
      if (!NOT_RELATIVE.test(match[2]) && !match[2].startsWith("//")) links.push({ line: index + 1, href: match[2] });
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

/**
 * The links of a store artifact's text as { line, href, target, resolved }, with target store:<location> of the artifact the link names or null:
 * location is the artifact's location below artifacts/, kinds the configured artifact kinds of a checkout of its repository, or Prism's default paths, and has(location) whether the store holds an artifact there.
 * A link resolves against the location first, and then through the artifact's checkout path, to a location of the artifact's own scope or else the workspace scope.
 */
export function resolveLinks({ content, location, kinds, has }) {
  const artifact = locationArtifact(location);
  const own = artifact ? checkoutPathOf(kinds, artifact) : null;
  return markdownLinks(content).map(({ line, href }) => {
    const target = resolveLink(href, { location, artifact, own, kinds, has });
    return { line, href, target, resolved: target !== null };
  });
}

function resolveLink(href, { location, artifact, own, kinds, has }) {
  const wanted = linkPath(href);
  if (wanted === null) return null;
  const direct = joined(path.posix.dirname(location), wanted);
  if (direct !== null && has(direct)) return `store:${direct}`;
  if (!artifact || own === null) return null;
  const file = joined(path.posix.dirname(own), wanted);
  const address = file === null ? null : artifactAddress(kinds, file);
  if (!address || address.rest === "") return null;
  for (const scope of artifact.scope.kind === "workspace" ? [WORKSPACE_SCOPE] : [artifact.scope, WORKSPACE_SCOPE]) {
    const candidate = artifactLocation(scope, address);
    if (has(candidate)) return `store:${candidate}`;
  }
  return null;
}
