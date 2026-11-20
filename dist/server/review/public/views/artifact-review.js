// Generated from src/server/review/public/views/artifact-review.ts by scripts/native-build/compile.mjs.
import { createActionList } from "./actions.js";
import { blockDiff } from "./block-diff.js";
import { diffHtml } from "./line-diff.js";
import { badge, chip, emptyNote, escapeHtml, formatTime, keyValues, plural } from "./util.js";
const commentTarget = (data) => data.artifact.target ?? `artifact:${data.artifact.scope?.label ?? "workspace"}:${data.path}`;
function acceptance(review) {
  if (!review.accepted) return badge("Never accepted", "warning");
  return review.changed ? badge("Changed since accepted", "warning") : badge("Matches the accepted version", "success");
}
function artifactChangesView(data, state, render) {
  const review = data.artifact;
  if (!review) return { row: "", body: null };
  if (review.accepted && review.accepted.content === null) {
    return { row: '<p class="notice artifact-changes-notice">The record store no longer holds the accepted version of this file, so its changes cannot be shown.</p>', body: null };
  }
  if (review.accepted && !review.changed) return { row: "", body: null };
  const before = review.accepted ? review.accepted.content : "";
  const diff = blockDiff(render(before), render(data.content));
  const shown = state.changesShown === true;
  const as = state.changesAs === "source" || !diff ? "source" : "rendered";
  const label = shown ? "Hide changes" : diff ? `Show ${plural(diff.changes, "change")}` : "Show changes";
  const choice = shown && diff ? `<prism-segmented label="Changes as" value="${as}" data-changes-as><span value="rendered">Rendered</span><span value="source">Source lines</span></prism-segmented>` : "";
  const legend = shown && as === "rendered" ? '<p class="artifact-diff-legend muted"><span class="artifact-diff-key" data-diff="added">Added</span><span class="artifact-diff-key" data-diff="changed">Changed</span><span class="artifact-diff-key" data-diff="removed">Removed</span></p>' : "";
  const row = `<div class="artifact-changes" data-artifact-changes>
    ${badge(review.accepted ? "Changed since the accepted version" : "Never accepted, so every block is new", "warning")}
    <prism-button size="sm" pressed="${shown}" data-changes-toggle><prism-icon name="eye" size="xs" aria-hidden="true"></prism-icon><span>${escapeHtml(label)}</span></prism-button>
    ${choice}
  </div>${legend}`;
  if (!shown) return { row, body: null };
  const labels = review.accepted ? { beforeLabel: "accepted version", afterLabel: "current version" } : { beforeLabel: "nothing accepted yet", afterLabel: "whole file" };
  const body = as === "rendered" ? `<prism-doc class="document-content" data-diff-view>${diff.html}</prism-doc>` : `<div class="artifact-source-diff" data-diff-view>${diffHtml(before, data.content, labels)}</div>`;
  return { row, body };
}
const linesOf = (content) => (String(content ?? "").match(/[^\n]*\n|[^\n]+$/g) ?? []).map((line) => line.replace(/\r?\n$/, ""));
function numberedLines(data, open) {
  const lines = linesOf(data.content);
  const rows = lines.map((line, index) => `<li class="artifact-line" id="L${index + 1}"><span class="artifact-line-number">${index + 1}</span><span class="artifact-line-text">${escapeHtml(line)}</span></li>`).join("");
  return `<prism-disclosure class="artifact-review-lines" summary="Lines of the current version" data-artifact-lines${open ? " open" : ""}>
    ${lines.length ? `<div class="artifact-lines-scroll"><ol class="artifact-lines">${rows}</ol></div>` : emptyNote("The file holds no lines.")}
  </prism-disclosure>`;
}
function topLine(box) {
  const lines = box.querySelectorAll(".artifact-line");
  if (!lines.length) return null;
  const boxTop = box.getBoundingClientRect().top;
  let low = 0, high = lines.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lines[middle].getBoundingClientRect().top - boxTop <= 0) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, offset: boxTop - lines[low].getBoundingClientRect().top };
}
function keepLinesInView(box, state) {
  if (!box) return;
  const kept = state.artifactLinesScroll;
  const restore = () => {
    const line = box.querySelector(`#L${kept.line}`);
    box.scrollTop = line ? line.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop + kept.offset : kept.top;
  };
  const staged = () => box.closest(".artifact-stage") !== null;
  const settle = () => {
    if (!box.isConnected) return;
    if (staged()) requestAnimationFrame(settle);
    else if (box.clientHeight) restore();
  };
  if (kept) {
    if (box.clientHeight && !staged()) restore();
    else requestAnimationFrame(settle);
  }
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
  return `<li class="artifact-comment" data-comment-id="${escapeHtml(String(comment.id))}" data-focus-key="comment:${escapeHtml(String(comment.id))}">
    <div class="artifact-comment-head">
      <span class="artifact-comment-author">${escapeHtml(comment.author?.name ?? "An unknown person")}</span>${host}
      ${chip(`Line ${escapeHtml(String(comment.line))}`)}${older}
      <time class="muted" datetime="${escapeHtml(comment.at)}">${escapeHtml(formatTime(comment.at))}</time>
    </div>
    <p class="artifact-comment-text">${escapeHtml(comment.text)}</p>
  </li>`;
}
const scopeLabel = (review) => review.scope?.label ?? "workspace";
const readsOf = (state) => Number.isSafeInteger(state.commentReads) && state.commentReads > 1 ? state.commentReads : 1;
const READ_TRIES = 3;
async function readListedComments(first, state, readPage) {
  let head = first;
  for (let attempt = 1; ; attempt += 1) {
    const listed = await readFurther(head, readsOf(state), readPage);
    if (listed || attempt === READ_TRIES) return listed;
    head = (await readPage(1)).artifact;
    if (!head) return null;
  }
}
async function readFurther(head, reads, readPage) {
  const comments = [...head.comments ?? []];
  const ids = new Set(comments.map((comment) => comment.id));
  let next = head.nextCommentOffset ?? null;
  for (let count = 1; count < reads && next !== null; count += 1) {
    const read = (await readPage(next)).artifact;
    if (!read || scopeLabel(read) !== scopeLabel(head) || read.totalComments !== head.totalComments) return null;
    for (const comment of read.comments ?? []) {
      if (ids.has(comment.id)) return null;
      ids.add(comment.id);
      comments.push(comment);
    }
    next = read.nextCommentOffset ?? null;
  }
  return { ...head, comments, nextCommentOffset: next };
}
function commentListHtml(review) {
  const comments = review.comments ?? [];
  const list = comments.length ? `<ol class="artifact-comments">${comments.map((comment) => commentHtml(comment, review.version)).join("")}</ol>` : emptyNote("No comments yet.");
  const more = review.nextCommentOffset != null ? '<div class="artifact-comments-more"><prism-button size="sm" data-more-comments data-focus-key="more-comments">More comments</prism-button></div>' : "";
  return `${list}${more}`;
}
const totalOf = (review) => Math.max(review.totalComments ?? 0, review.comments?.length ?? 0);
function artifactReviewHtml(data, state = {}) {
  const review = data.artifact;
  if (!review) return "";
  return `<prism-panel class="view-section artifact-review" heading="Review">
    ${keyValues([["Scope", chip(escapeHtml(review.scope?.label ?? "workspace"), { attributes: " data-scope-label" })], ["Accepted", acceptance(review)]])}
    ${numberedLines(data, state.artifactLinesOpen === true)}
    <section class="artifact-review-comments" aria-labelledby="artifact-comments-heading">
      <h3 class="artifact-review-subheading" id="artifact-comments-heading">${escapeHtml(plural(totalOf(review), "comment"))}</h3>
      <div class="artifact-comment-list" data-comment-list>${commentListHtml(review)}</div>
      <div data-comment-form></div>
    </section>
  </prism-panel>`;
}
function bindMoreComments(root, data, state, { readPage, onListed }) {
  const button = root.querySelector("[data-more-comments]");
  if (!button) return;
  let reading = false;
  button.addEventListener("click", async () => {
    if (reading) return;
    reading = true;
    const before = new Set((data.artifact.comments ?? []).map((comment) => comment.id));
    state.moreBefore = before;
    state.commentReads = readsOf(state) + 1;
    let listed = null;
    try {
      const first = (await readPage(1)).artifact;
      listed = first ? await readListedComments(first, state, readPage) : null;
    } catch {
    }
    reading = false;
    const list = root.querySelector("[data-comment-list]");
    if (state.moreBefore === before) delete state.moreBefore;
    if (!button.isConnected) {
      if (list?.isConnected && !list.contains(document.activeElement)) focusAfterMore(list, before);
      return;
    }
    if (!list?.isConnected) return;
    if (!listed || scopeLabel(listed) !== scopeLabel(data.artifact)) {
      if (!listed) state.commentReads = readsOf(state) - 1;
      return;
    }
    data.artifact = { ...data.artifact, ...listed };
    list.innerHTML = commentListHtml(data.artifact);
    const heading = root.querySelector("#artifact-comments-heading");
    if (heading) heading.textContent = plural(totalOf(data.artifact), "comment");
    onListed?.(data);
    bindMoreComments(root, data, state, { readPage, onListed });
    focusAfterMore(list, before);
  });
}
function focusAfterMore(list, before) {
  const next = list.querySelector("[data-more-comments]");
  const added = [...list.querySelectorAll("[data-comment-id]")].find((item) => !before.has(item.dataset.commentId));
  if (next) next.focus({ preventScroll: true });
  else if (added) {
    added.tabIndex = -1;
    added.focus({ preventScroll: true });
  }
  return Boolean(next || added);
}
function mountArtifactReview(root, data, { actionApi, state, readPage, onListed }) {
  root.querySelector("[data-artifact-lines]")?.addEventListener("toggle", (event) => {
    state.artifactLinesOpen = event.detail.open === true;
  });
  keepLinesInView(root.querySelector(".artifact-lines-scroll"), state);
  const card = root.querySelector(".artifact-review");
  if (card && data.artifact && readPage) bindMoreComments(card, data, state, { readPage, onListed });
  const slot = root.querySelector("[data-comment-form]");
  if (!slot || !data.artifact || !actionApi) return null;
  const target = commentTarget(data);
  const kept = state.commentForm;
  if (kept) {
    slot.replaceWith(kept.element);
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
    drafts: state.actionDrafts ??= {},
    heading: () => ({ label: "Add a comment", detail: "" }),
    submitLabel: () => "Comment",
    emptyText: "This file takes no comments.",
    // A comment stays meaningful when the file changed under it, so it is kept for the person to send again against the current file.
    keepStaleDrafts: true
  });
  state.commentForm = { target, element, list };
  return list;
}
export {
  artifactChangesView,
  artifactReviewHtml,
  commentTarget,
  focusAfterMore,
  mountArtifactReview,
  readListedComments
};
