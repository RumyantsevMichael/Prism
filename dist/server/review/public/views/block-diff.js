// The changes between two renderings of one Markdown file, drawn on the rendered text: each top-level block of the newer rendering is kept, added, or changed,
// and each block only the older one has is put back where it stood, marked removed. A changed block marks the words it gained and those it lost.
import { diffItems } from "./line-diff.js";

// A block pairs with a removed one of the same kind as a change when at least this share of their words is shared; otherwise it is an addition beside a removal.
const SIMILAR = 0.4;

const blocksOf = (html) => {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return [...holder.children];
};

// A block's identity for matching: its markup without the ids that the renderer derives from heading text.
const keyOf = (block) => block.outerHTML.replace(/\sid="[^"]*"/g, "");
const words = (text) => text.split(/\s+/).filter(Boolean);

function similarity(left, right) {
  const a = new Set(words(left.textContent)), b = new Set(words(right.textContent));
  if (!a.size && !b.size) return 1;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / Math.max(a.size, b.size);
}

// The words and punctuation marks of a text with where each starts and ends; the spaces between them are not compared.
const tokensOf = (text) => [...text.matchAll(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));

// A lone kept word between two changes, such as "the" or a comma, reads as part of one change, so it joins them rather than splitting the change in two.
function joinChanges(ops) {
  const out = [...ops];
  for (let index = 1; index < out.length - 1; index++) {
    if (out[index].op !== "same" || out[index - 1].op === "same" || out[index + 1].op === "same") continue;
    const kept = out[index];
    out.splice(index, 1, { op: "del", before: kept.before }, { op: "add", after: kept.after });
  }
  return out;
}

/**
 * Marks in `block` each run of words that `before` lacked, wrapped in <ins>, with the words it lost there put back in <del> before it.
 * Returns false when the texts are too large to compare word by word, which leaves the block as it is.
 */
function markWords(block, before) {
  const text = block.textContent, oldText = before.textContent;
  const old = tokensOf(oldText), now = tokensOf(text);
  const ops = diffItems(old.map((token) => token.text), now.map((token) => token.text));
  if (!ops) return false;
  // Each run of changes between kept words: the inserted range in the block's text, and the lost text with the offset it goes before.
  const inserted = [];
  const lost = [];
  let previousEnd = 0, dels = [], adds = [];
  const close = () => {
    if (adds.length) inserted.push({ start: now[adds[0]].start, end: now[adds.at(-1)].end });
    if (dels.length) lost.push({ at: adds.length ? now[adds[0]].start : previousEnd, text: oldText.slice(old[dels[0]].start, old[dels.at(-1)].end) });
    dels = [];
    adds = [];
  };
  for (const entry of joinChanges(ops)) {
    if (entry.op === "del") dels.push(entry.before);
    else if (entry.op === "add") adds.push(entry.after);
    else {
      close();
      previousEnd = now[entry.after].end;
    }
  }
  close();
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  let start = 0;
  for (const node of nodes) {
    const end = start + node.data.length;
    // The cut points inside this node: where an inserted range starts or ends, and where lost text goes.
    const cuts = new Set([0, node.data.length]);
    for (const range of inserted) for (const at of [range.start, range.end]) if (at > start && at < end) cuts.add(at - start);
    for (const item of lost) if (item.at > start && item.at < end) cuts.add(item.at - start);
    const points = [...cuts].sort((left, right) => left - right);
    const parts = [];
    for (let index = 0; index < points.length - 1; index++) {
      const from = start + points[index], to = start + points[index + 1];
      for (const item of lost) if (item.at === from && !item.placed) { parts.push(...lostNodes(item, text)); item.placed = true; }
      const piece = node.data.slice(points[index], points[index + 1]);
      if (inserted.some((range) => from >= range.start && to <= range.end)) {
        const ins = document.createElement("ins");
        ins.className = "prism-doc-ins";
        ins.textContent = piece;
        parts.push(ins);
      } else parts.push(document.createTextNode(piece));
    }
    node.replaceWith(...parts);
    start = end;
  }
  // Text lost at the very end of the block follows its last word.
  for (const item of lost) if (!item.placed) block.append(...lostNodes(item, text));
  return true;
}

// Lost text keeps a space from a word it would otherwise touch, before or after it.
const WORD = /[\p{L}\p{N}_]/u;
function lostNodes(item, text) {
  const nodes = [lostNode(item.text)];
  if (WORD.test(text[item.at - 1] ?? "") && WORD.test(item.text[0])) nodes.unshift(document.createTextNode(" "));
  if (WORD.test(text[item.at] ?? "") && WORD.test(item.text.at(-1))) nodes.push(document.createTextNode(" "));
  return nodes;
}

function lostNode(text) {
  const del = document.createElement("del");
  del.className = "prism-doc-del";
  del.textContent = text;
  return del;
}

const marked = (block, change) => {
  block.dataset.diff = change;
  return block;
};

/**
 * The blocks of `afterHtml` with each change against `beforeHtml` marked by data-diff (added, removed, or changed), and the count of changed blocks,
 * as { html, changes }; or null when the two have too many blocks to compare.
 */
export function blockDiff(beforeHtml, afterHtml) {
  const before = blocksOf(beforeHtml), after = blocksOf(afterHtml);
  const ops = diffItems(before.map(keyOf), after.map(keyOf));
  if (!ops) return null;
  const out = [];
  let changes = 0;
  // A run of removals and additions between kept blocks pairs each addition with the next removal of its kind that reads alike.
  const flush = (dels, adds) => {
    let next = 0;
    for (const add of adds) {
      const block = after[add];
      const found = dels.findIndex((del, index) => index >= next && before[del].tagName === block.tagName && similarity(before[del], block) >= SIMILAR);
      if (found === -1) {
        out.push(marked(block, "added"));
        changes++;
        continue;
      }
      for (const del of dels.slice(next, found)) out.push(removed(before[del]));
      changes += found - next;
      markWords(block, before[dels[found]]);
      out.push(marked(block, "changed"));
      changes++;
      next = found + 1;
    }
    for (const del of dels.slice(next)) out.push(removed(before[del]));
    changes += dels.length - next;
  };
  let dels = [], adds = [];
  for (const entry of ops) {
    if (entry.op === "del") dels.push(entry.before);
    else if (entry.op === "add") adds.push(entry.after);
    else {
      flush(dels, adds);
      dels = [];
      adds = [];
      out.push(after[entry.after]);
    }
  }
  flush(dels, adds);
  return { html: out.map((block) => block.outerHTML).join(""), changes };
}

// A removed block keeps no ids, so a heading that stays under the same title is still the one a link reaches.
function removed(block) {
  for (const node of [block, ...block.querySelectorAll("[id]")]) node.removeAttribute("id");
  return marked(block, "removed");
}
