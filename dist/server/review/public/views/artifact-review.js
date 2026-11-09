import { createActionList } from "./actions.js";
import { diffHtml } from "./line-diff.js";
import { badge, chip, emptyNote, escapeHtml, formatTime, keyValues, plural } from "./util.js";

// The review view of a store artifact, shown above its content: its scope, its lines against the version a person last accepted, and the comments people left on it,
// with a form that comments through the review app's artifact.comment action, as every other change of the page goes through the actions registry.

/** The action target of a store artifact: artifact:<scope label>:<path>, which no scope label or artifact name can make ambiguous, since neither holds a ":". */
export const commentTarget = (data) => `artifact:${data.artifact.scope?.label ?? "workspace"}:${data.path}`;

function acceptance(review) {
  if (!review.accepted) return badge("Never accepted", "warning");
  return review.changed ? badge("Changed since accepted", "warning") : badge("Matches the accepted version", "success");
}

// The changed lines against the accepted version, or the whole file as added when nothing was accepted yet; the diff's line numbers are the ones a comment names.
function changes(data) {
  const review = data.artifact;
  if (review.accepted && review.accepted.content === null) {
    return '<p class="notice">The record store no longer holds the accepted version of this file, so its changes cannot be shown.</p>';
  }
  if (review.accepted && !review.changed) return emptyNote("The file is the version a person last accepted.");
  const before = review.accepted ? review.accepted.content : "";
  const labels = review.accepted ? { beforeLabel: "accepted version", afterLabel: "current version" } : { beforeLabel: "nothing accepted yet", afterLabel: "whole file" };
  const summary = review.accepted ? "Changes since the accepted version" : "The whole file, as nothing was accepted yet";
  return `<prism-disclosure summary="${escapeHtml(summary)}" open>${diffHtml(before, data.content, labels)}</prism-disclosure>`;
}

// The lines of a text as get_artifact numbers them for offset: each ends at a line feed, and a last line without one still counts.
const linesOf = (content) => (String(content ?? "").match(/[^\n]*\n|[^\n]+$/g) ?? []).map((line) => line.replace(/\r?\n$/, ""));

// Every line of the current version with its number, also when the file matches its accepted version and for the lines the changes leave out,
// so the person reads here the number that a comment's line takes; it opens as the person left it, and is closed when the page opens.
function numberedLines(data, open) {
  const lines = linesOf(data.content);
  const rows = lines.map((line, index) => `<li class="artifact-line" id="L${index + 1}"><span class="artifact-line-number">${index + 1}</span><span class="artifact-line-text">${escapeHtml(line)}</span></li>`).join("");
  return `<prism-disclosure class="artifact-review-lines" summary="Lines of the current version" data-artifact-lines${open ? " open" : ""}>
    ${lines.length ? `<div class="artifact-lines-scroll"><ol class="artifact-lines">${rows}</ol></div>` : emptyNote("The file holds no lines.")}
  </prism-disclosure>`;
}

// The line at the top of the numbered lines' own scroll box, as { line, offset } with offset the pixels the box has scrolled past that line's top, found by halving.
function topLine(box) {
  const lines = box.querySelectorAll(".artifact-line");
  if (!lines.length) return null;
  const boxTop = box.getBoundingClientRect().top;
  let low = 0, high = lines.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lines[middle].getBoundingClientRect().top - boxTop <= 0) low = middle; else high = middle - 1;
  }
  return { line: low + 1, offset: boxTop - lines[low].getBoundingClientRect().top };
}

// The page redraws the card for a changed file or an arriving comment, so the numbered lines' scroll box shows the line the person scrolled to again,
// as the page keeps its own scroll; a line that no longer exists leaves the box where it was.
function keepLinesInView(box, state) {
  if (!box) return;
  const kept = state.artifactLinesScroll;
  const restore = () => {
    const line = box.querySelector(`#L${kept.line}`);
    box.scrollTop = line ? line.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop + kept.offset : kept.top;
  };
  // A box that is not laid out yet, as while its disclosure still renders, takes its place on the next frame.
  if (kept) { if (box.clientHeight) restore(); else requestAnimationFrame(() => { if (box.isConnected && box.clientHeight) restore(); }); }
  let pending = false;
  box.addEventListener("scroll", () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (!box.isConnected) return;
      const found = topLine(box);
      state.artifactLinesScroll = found ? { ...found, top: box.scrollTop } : null;
    });
  });
}

function commentHtml(comment, version) {
  const host = comment.author?.host ? `<span class="muted">${escapeHtml(comment.author.host)}</span>` : "";
  const older = comment.version && comment.version !== version ? chip("On an earlier version") : "";
  return `<li class="artifact-comment">
    <div class="artifact-comment-head">
      <span class="artifact-comment-author">${escapeHtml(comment.author?.name ?? "An unknown person")}</span>${host}
      ${chip(`Line ${escapeHtml(String(comment.line))}`)}${older}
      <time class="muted" datetime="${escapeHtml(comment.at)}">${escapeHtml(formatTime(comment.at))}</time>
    </div>
    <p class="artifact-comment-text">${escapeHtml(comment.text)}</p>
  </li>`;
}

/** The review view's markup for an artifact the record store serves, or "" for any other file; state is the page's view state of the file, which keeps the numbered lines open or closed. */
export function artifactReviewHtml(data, state = {}) {
  const review = data.artifact;
  if (!review) return "";
  const comments = review.comments ?? [];
  return `<prism-panel class="view-section artifact-review" heading="Review">
    ${keyValues([["Scope", chip(escapeHtml(review.scope?.label ?? "workspace"))], ["Accepted", acceptance(review)]])}
    <div class="artifact-review-changes">${changes(data)}</div>
    ${numberedLines(data, state.artifactLinesOpen === true)}
    <section class="artifact-review-comments" aria-labelledby="artifact-comments-heading">
      <h3 class="artifact-review-subheading" id="artifact-comments-heading">${escapeHtml(plural(comments.length, "comment"))}</h3>
      ${comments.length ? `<ol class="artifact-comments">${comments.map((comment) => commentHtml(comment, review.version)).join("")}</ol>` : emptyNote("No comments yet.")}
      <div data-comment-form></div>
    </section>
  </prism-panel>`;
}

/**
 * Draws the comment form of a rendered review view from the artifact's action listing.
 * The page redraws the view when the file or its comments change, so the form's element is kept in state and moved into the new view,
 * which keeps an unsent comment, its focus, and its cursor while other people's comments arrive.
 */
export function mountArtifactReview(root, data, { actionApi, state }) {
  // The page redraws the card for a changed file or an arriving comment, so the numbered lines stay open or closed as the person left them.
  root.querySelector("[data-artifact-lines]")?.addEventListener("toggle", (event) => { state.artifactLinesOpen = event.detail.open === true; });
  keepLinesInView(root.querySelector(".artifact-lines-scroll"), state);
  const slot = root.querySelector("[data-comment-form]");
  if (!slot || !data.artifact || !actionApi) return null;
  const target = commentTarget(data);
  const kept = state.commentForm;
  if (kept) {
    slot.replaceWith(kept.element);
    // The view state belongs to one path, so a new target names the same file in another scope, and an unsent comment follows it there.
    if (kept.target === target) void kept.list.refresh();
    else void kept.list.retarget(kept.target, target);
    kept.target = target;
    return kept.list;
  }
  const element = document.createElement("div");
  element.dataset.commentForm = "";
  slot.replaceWith(element);
  const list = createActionList({
    root: element,
    targets: [target],
    api: actionApi,
    drafts: (state.actionDrafts ??= {}),
    heading: () => ({ label: "Add a comment", detail: "" }),
    submitLabel: () => "Comment",
    emptyText: "This file takes no comments.",
    // A comment stays meaningful when the file changed under it, so it is kept for the person to send again against the current file.
    keepStaleDrafts: true
  });
  state.commentForm = { target, element, list };
  return list;
}
