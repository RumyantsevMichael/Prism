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
  // A box that is not shown yet, as while its disclosure still renders or while the page builds the view out of sight, takes its place once it is shown,
  // since moving the box into the page drops its scroll; a box that leaves the page first is left alone.
  const staged = () => box.closest(".artifact-stage") !== null;
  const settle = () => {
    if (!box.isConnected) return;
    if (staged()) requestAnimationFrame(settle);
    else if (box.clientHeight) restore();
  };
  if (kept) { if (box.clientHeight && !staged()) restore(); else requestAnimationFrame(settle); }
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
  // A comment that More comments gave focus keeps it by its key while the page redraws the card, as the page restores focus by data-focus-key.
  return `<li class="artifact-comment" data-comment-id="${escapeHtml(String(comment.id))}" data-focus-key="comment:${escapeHtml(String(comment.id))}">
    <div class="artifact-comment-head">
      <span class="artifact-comment-author">${escapeHtml(comment.author?.name ?? "An unknown person")}</span>${host}
      ${chip(`Line ${escapeHtml(String(comment.line))}`)}${older}
      <time class="muted" datetime="${escapeHtml(comment.at)}">${escapeHtml(formatTime(comment.at))}</time>
    </div>
    <p class="artifact-comment-text">${escapeHtml(comment.text)}</p>
  </li>`;
}

// A read carries at most 20 comments, so the card lists the comments of as many reads as the person asked for, the first one and one more for each press of More comments.
// state.commentReads counts them, and every redraw and every press reads them all again from the first comment,
// so the list is always the file's first comments in their current order, also after a sync brings a comment that sorts among the listed ones or one of them goes.
const scopeLabel = (review) => review.scope?.label ?? "workspace";
const readsOf = (state) => Number.isSafeInteger(state.commentReads) && state.commentReads > 1 ? state.commentReads : 1;
const READ_TRIES = 3;

/**
 * The artifact of a first read with the comments of state's further reads added, each read from the last one's nextCommentOffset, and that last read's nextCommentOffset;
 * readPage(commentOffset) reads /api/artifact from that comment. Reads that a change between them made disagree, by count, scope, or a comment listed twice,
 * are made again from a new first read, and after three tries the result is null, so the page keeps what it shows until its next redraw.
 */
export async function readListedComments(first, state, readPage) {
  let head = first;
  for (let attempt = 1; ; attempt += 1) {
    const listed = await readFurther(head, readsOf(state), readPage);
    if (listed || attempt === READ_TRIES) return listed;
    head = (await readPage(1)).artifact;
    if (!head) return null;
  }
}

async function readFurther(head, reads, readPage) {
  const comments = [...(head.comments ?? [])];
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

// The listed comments and, while the last read left comments out, the More comments button that reads the next ones.
function commentListHtml(review) {
  const comments = review.comments ?? [];
  const list = comments.length ? `<ol class="artifact-comments">${comments.map((comment) => commentHtml(comment, review.version)).join("")}</ol>` : emptyNote("No comments yet.");
  const more = review.nextCommentOffset != null ? '<div class="artifact-comments-more"><prism-button size="sm" data-more-comments data-focus-key="more-comments">More comments</prism-button></div>' : "";
  return `${list}${more}`;
}
const totalOf = (review) => Math.max(review.totalComments ?? 0, review.comments?.length ?? 0);

/** The review view's markup for an artifact the record store serves, or "" for any other file; state is the page's view state of the file, which keeps the numbered lines open or closed and how many comment reads the card lists. */
export function artifactReviewHtml(data, state = {}) {
  const review = data.artifact;
  if (!review) return "";
  return `<prism-panel class="view-section artifact-review" heading="Review">
    ${keyValues([["Scope", chip(escapeHtml(review.scope?.label ?? "workspace"))], ["Accepted", acceptance(review)]])}
    <div class="artifact-review-changes">${changes(data)}</div>
    ${numberedLines(data, state.artifactLinesOpen === true)}
    <section class="artifact-review-comments" aria-labelledby="artifact-comments-heading">
      <h3 class="artifact-review-subheading" id="artifact-comments-heading">${escapeHtml(plural(totalOf(review), "comment"))}</h3>
      <div class="artifact-comment-list" data-comment-list>${commentListHtml(review)}</div>
      <div data-comment-form></div>
    </section>
  </prism-panel>`;
}

/**
 * More comments asks for one more read and reads every listed read again with it, then lists them in place.
 * Focus moves to the More comments button that follows the added comments, or to the first added comment when none follows, so a keyboard reader goes on from where the list grew.
 * A redraw that replaced the card meanwhile already lists as many reads, as state counts them before the reads start; onListed hands the page what the card now lists.
 */
function bindMoreComments(root, data, state, { readPage, onListed }) {
  const button = root.querySelector("[data-more-comments]");
  if (!button) return;
  let reading = false;
  button.addEventListener("click", async () => {
    // The button stays enabled while it reads, as a disabled one would drop its focus to the page.
    if (reading) return;
    reading = true;
    const before = new Set((data.artifact.comments ?? []).map((comment) => comment.id));
    // A redraw that lands while this read runs lists the added comments first, so it finds where focus goes from the comments listed before the press.
    state.moreBefore = before;
    state.commentReads = readsOf(state) + 1;
    let listed = null;
    try {
      const first = (await readPage(1)).artifact;
      listed = first ? await readListedComments(first, state, readPage) : null;
    } catch { /* A failed read leaves the list as it is, and the person can press again. */ }
    reading = false;
    const list = root.querySelector("[data-comment-list]");
    if (state.moreBefore === before) delete state.moreBefore;
    // A redraw that replaced the card meanwhile listed the comments already; focus that it left outside the card goes where this press would have put it.
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

/**
 * Move focus where a press of More comments leads in a comment list: to the More comments button that follows the added comments, or else to the first comment not among those listed before,
 * which takes focus without entering the tab order; returns whether it found either.
 */
export function focusAfterMore(list, before) {
  const next = list.querySelector("[data-more-comments]");
  const added = [...list.querySelectorAll("[data-comment-id]")].find((item) => !before.has(item.dataset.commentId));
  if (next) next.focus({ preventScroll: true });
  else if (added) { added.tabIndex = -1; added.focus({ preventScroll: true }); }
  return Boolean(next || added);
}

/**
 * Draws the comment form of a rendered review view from the artifact's action listing.
 * The page redraws the view when the file or its comments change, so the form's element is kept in state and moved into the new view,
 * which keeps an unsent comment, its focus, and its cursor while other people's comments arrive.
 */
export function mountArtifactReview(root, data, { actionApi, state, readPage, onListed }) {
  // The page redraws the card for a changed file or an arriving comment, so the numbered lines stay open or closed as the person left them.
  root.querySelector("[data-artifact-lines]")?.addEventListener("toggle", (event) => { state.artifactLinesOpen = event.detail.open === true; });
  keepLinesInView(root.querySelector(".artifact-lines-scroll"), state);
  // The page may build the view out of sight and move it into place, so More comments works within the review card, which moves with it.
  const card = root.querySelector(".artifact-review");
  if (card && data.artifact && readPage) bindMoreComments(card, data, state, { readPage, onListed });
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
