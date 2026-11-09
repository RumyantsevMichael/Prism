// prism-toast: the page's one polite live region; show(message, { tone }) replaces any shown message on frosted glass and hides it after a fixed time.
import { Base, make, setAttribute } from "./base.js";

/** How long a message shows, the same under reduced motion. */
export const TOAST_DURATION = 5000;
const TONES = ["neutral", "info", "success", "warning", "danger"];
const ICONS = { info: "info", success: "check", warning: "warning", danger: "warning" };

export class PrismToast extends Base {
  static tag = "prism-toast";
  static catalog = {
    purpose: "The page's one polite live region: it shows a short message on frosted glass at the bottom of the window for five seconds, replacing any shown message.",
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
    this.timer = setTimeout(() => this.hide(), TOAST_DURATION);
  }

  hide() {
    clearTimeout(this.timer);
    this.replaceChildren();
    this.toggleAttribute("shown", false);
  }
}
