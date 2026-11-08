// Who's working: the top bar button with a stack of up to three breathing avatars of the live claims and their count,
// and its popover, which lists every live claim and then every expired claim of the listed initiatives. Nothing here takes, releases, or renews a claim.
import { everyMinute, timeLeft } from "../kit/claim-time.js";
import { claimElement } from "./claim-index.js";

const STACK = 3;

function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

/** One line of the popover: the holder as an agent, the activity, the slice's title as a link, and the time left. */
function claimRow(claim, onOpen) {
  const row = document.createElement("li");
  row.className = `presence-row${claim.expired ? " is-expired" : ""}`;
  const holder = text("span", "presence-holder", "");
  holder.append(text("span", "presence-name", claim.label), " ", text("span", "presence-kind", "Agent"));
  const what = text("span", "presence-what", "");
  const link = text("a", "presence-slice", claim.sliceTitle);
  link.href = `./review?artifact=${encodeURIComponent(claim.ref)}`;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    onOpen(claim.ref);
  });
  what.append(text("span", "presence-activity", claim.activity), " · ", link);
  const time = text("span", "presence-time", timeLeft(claim.expiresAt).text);
  time.dataset.expiresAt = claim.expiresAt ?? "";
  row.append(claimElement(claim, "avatar"), holder, what, time);
  return row;
}

export function createPresence({ button, popover, claims, onOpen }) {
  let rendered = "";
  // The popover keeps its own heading and body, so the list renders into one holder inside its body.
  const content = text("div", "presence-content", "");
  popover.append(content);

  function render() {
    const live = claims.live();
    const expired = claims.expired();
    const key = JSON.stringify([live, expired]);
    if (key === rendered) return;
    rendered = key;
    const stack = text("span", "presence-stack", "");
    for (const claim of live.slice(0, STACK)) {
      const avatar = document.createElement("prism-avatar");
      avatar.setAttribute("kind", "agent");
      avatar.setAttribute("name", claim.label);
      avatar.setAttribute("size", "sm");
      avatar.toggleAttribute("live", true);
      avatar.toggleAttribute("breathing", true);
      stack.append(avatar);
    }
    if (live.length > STACK) stack.append(text("span", "presence-more", `+${live.length - STACK}`));
    const count = `${live.length} working`;
    const lapsed = expired.length ? `, ${expired.length} ${expired.length === 1 ? "claim" : "claims"} expired` : "";
    // The button's own text names it, so it keeps its width; the tip adds the expired claims.
    button.setAttribute("tip", `Who's working: ${count}${lapsed}`);
    button.replaceChildren(...(live.length ? [stack] : []), text("span", "presence-count", count));
    const body = [];
    if (!live.length && !expired.length) body.push(text("p", "presence-none", "No agent holds a claim on a slice of these initiatives."));
    if (live.length) {
      body.push(text("p", "presence-group", "Working now"));
      const list = text("ul", "presence-list", "");
      list.append(...live.map((claim) => claimRow({ ...claim, expired: false }, onOpen)));
      body.push(list);
    }
    if (expired.length) {
      body.push(text("p", "presence-group", "Claims that expired"));
      const list = text("ul", "presence-list", "");
      list.append(...expired.map((claim) => claimRow({ ...claim, expired: true }, onOpen)));
      body.push(list);
    }
    body.push(text("p", "presence-note", "Agents claim a slice while they design or build it. A claim that expired was not released."));
    content.replaceChildren(...body);
  }

  // A claim's time words, and whether it still counts as live, change with the clock.
  everyMinute(() => {
    rendered = "";
    render();
    for (const time of content.querySelectorAll("[data-expires-at]")) time.textContent = timeLeft(time.dataset.expiresAt).text;
  });
  popover.addEventListener("click", (event) => {
    if (event.target.closest?.("a.presence-slice")) popover.close?.();
  });
  render();
  return { render };
}
