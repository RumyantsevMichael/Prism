// Generated from src/server/review/public/kit/elements/prism-agent-summary.ts by scripts/native-build/compile.mjs.
import { setAttribute } from "./base.js";
import { PrismButton } from "./prism-button.js";
const STACK = 3;
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const whole = (value) => Math.max(0, Number.parseInt(value ?? "", 10) || 0);
function agentSummaryName({ working = 0, failed = 0, noResult = 0, waiting = 0, expired = 0 } = {}) {
  return [`Agents: ${working} working`, failed ? `${failed} failed` : "", noResult ? `${noResult} ended without a result` : "", waiting ? `${waiting} waits` : "", expired ? `${plural(expired, "claim", "claims")} expired` : ""].filter(Boolean).join(", ");
}
class PrismAgentSummary extends PrismButton {
  static tag = "prism-agent-summary";
  static styles = ["prism-button.css", "prism-agent-summary.css"];
  static observedAttributes = [...PrismButton.observedAttributes, "working", "failed", "no-result", "waiting", "expired", "needs"];
  static catalog = {
    purpose: "The top bar's agents button: a chrome kit button that shows up to three live agent avatars, how many agents work, and a danger, an info, and a warning status badge while launched sessions fail, end without a result, or wait; a window 1100 pixels wide or less shows two avatars, `<n> no result`, and while a badge shows the working count without its word; a window 600 pixels wide or less shows two avatars and one corner count of the sessions that need the person, danger while one failed.",
    options: [
      { name: "working", values: ["number"], default: "0", description: "How many agents work; it draws one live avatar each up to three, and +<n> for the rest." },
      { name: "failed", values: ["number"], default: "0", description: "How many launched sessions failed, as a danger status badge." },
      { name: "no-result", values: ["number"], default: "0", description: "How many launched sessions ended without a result, as an info status badge between the failed and the waiting badge." },
      { name: "waiting", values: ["number"], default: "0", description: "How many launched sessions wait for the person, as a warning status badge." },
      { name: "expired", values: ["number"], default: "0", description: "How many claims expired, which only the accessible name says." },
      { name: "needs", values: ["number"], default: "failed + no-result + waiting", description: "The corner count of a phone-width window: the sessions that need the person." }
    ],
    states: ["quiet", "working", "needs-you", "many"],
    keyboard: ["Enter and Space activate the button, which opens its popover."]
  };
  constructor() {
    super();
    this.words.remove();
    this.content = this.root.querySelector(".content");
    this.content.innerHTML = `<span class="stack" part="stack"></span><span class="count" part="count"></span><span class="marks" part="marks"><prism-badge class="failed" variant="status" tone="danger" hidden></prism-badge><prism-badge class="no-result" variant="status" tone="info" hidden></prism-badge><prism-badge class="waiting" variant="status" tone="warning" hidden></prism-badge></span>`;
    this.root.querySelector(".badge").remove();
    this.corner = this.root.ownerDocument.createElement("span");
    this.corner.className = "corner";
    this.corner.setAttribute("part", "corner");
    this.corner.innerHTML = `<prism-badge size="sm" hidden></prism-badge>`;
    this.control.append(this.corner);
    this.cornerBadge = this.corner.firstElementChild;
  }
  get counts() {
    const failed = whole(this.getAttribute("failed"));
    const noResult = whole(this.getAttribute("no-result"));
    const waiting = whole(this.getAttribute("waiting"));
    return { working: whole(this.getAttribute("working")), failed, noResult, waiting, expired: whole(this.getAttribute("expired")), needs: this.hasAttribute("needs") ? whole(this.getAttribute("needs")) : failed + noResult + waiting };
  }
  sync() {
    super.sync();
    if (!this.content) return;
    const counts = this.counts;
    setAttribute(this.control, "aria-label", agentSummaryName(counts));
    const stack = this.content.querySelector(".stack");
    const avatars = Math.min(STACK, counts.working);
    const more = counts.working - avatars;
    const key = `${avatars}/${more}`;
    if (stack.dataset.key !== key) {
      stack.dataset.key = key;
      stack.innerHTML = `${'<prism-avatar kind="agent" size="sm" live breathing aria-hidden="true"></prism-avatar>'.repeat(avatars)}${more ? `<span class="more" aria-hidden="true">+${more}</span>` : ""}`;
    }
    stack.hidden = avatars === 0;
    const words = `${counts.working}<span class="count-words"> working</span>`;
    const count = this.content.querySelector(".count");
    if (count.dataset.html !== words) {
      count.dataset.html = words;
      count.innerHTML = words;
    }
    const noResult = `${counts.noResult} <span class="words-long">ended without a result</span><span class="words-short">no result</span>`;
    for (const [name, value, html] of [["failed", counts.failed, `${counts.failed} failed`], ["no-result", counts.noResult, noResult], ["waiting", counts.waiting, `${counts.waiting} waits`]]) {
      const badge = this.content.querySelector(`.${name}`);
      badge.hidden = value === 0;
      if (badge.dataset.html !== html) {
        badge.dataset.html = html;
        badge.innerHTML = html;
      }
    }
    const marked = counts.failed + counts.noResult + counts.waiting > 0;
    this.content.querySelector(".marks").hidden = !marked;
    this.content.classList.toggle("marked", marked);
    this.corner.hidden = counts.needs === 0;
    this.cornerBadge.hidden = counts.needs === 0;
    setAttribute(this.cornerBadge, "tone", counts.failed ? "danger" : "warning");
    if (this.cornerBadge.textContent !== String(counts.needs)) this.cornerBadge.textContent = String(counts.needs);
  }
}
export {
  PrismAgentSummary,
  agentSummaryName
};
