// Generated from src/server/review/public/kit/elements/prism-toast.ts by scripts/native-build/compile.mjs.
import { Base, make, setAttribute } from "./base.js";
const TOAST_DURATION = 5e3;
const TONES = ["neutral", "info", "success", "warning", "danger"];
const ICONS = { info: "info", success: "check", warning: "warning", danger: "warning" };
class PrismToast extends Base {
  static tag = "prism-toast";
  static catalog = {
    purpose: "The page's one polite live region: it shows a short message on frosted glass at the bottom of the window for five seconds, replacing any shown message, above every open dialog.",
    options: [
      { name: "show(message, { tone })", values: ["method"], default: "", description: "Shows a message in a tone (neutral, info, success, warning, or danger), replacing any shown one." },
      { name: "hide()", values: ["method"], default: "", description: "Hides the shown message at once." }
    ],
    states: ["hidden", "shown"],
    keyboard: []
  };
  connectedCallback() {
    setAttribute(this, "role", "status");
    setAttribute(this, "aria-live", "polite");
  }
  /** Shows `message`, replacing any shown message, and hides it after TOAST_DURATION. */
  show(message, { tone = "neutral" } = {}) {
    clearTimeout(this.timer);
    const shownTone = TONES.includes(tone) ? tone : "neutral";
    const parts = [];
    if (ICONS[shownTone]) parts.push(make(this, "prism-icon", "prism-toast-icon", { name: ICONS[shownTone], size: "sm" }));
    const text = make(this, "span", "prism-toast-message");
    text.textContent = String(message ?? "");
    parts.push(text);
    this.replaceChildren(...parts);
    setAttribute(this, "tone", shownTone);
    this.toggleAttribute("shown", true);
    this.raise();
    this.timer = setTimeout(() => this.hide(), TOAST_DURATION);
  }
  hide() {
    clearTimeout(this.timer);
    this.replaceChildren();
    this.toggleAttribute("shown", false);
    if (this.matches?.(":popover-open")) this.hidePopover();
    this.removeAttribute("popover");
  }
  // A shown message enters the top layer above every open dialog, so a message about a change made in a modal dialog is not left under its backdrop.
  raise() {
    if (typeof this.showPopover !== "function") return;
    setAttribute(this, "popover", "manual");
    if (this.matches(":popover-open")) this.hidePopover();
    this.showPopover();
  }
}
export {
  PrismToast,
  TOAST_DURATION
};
