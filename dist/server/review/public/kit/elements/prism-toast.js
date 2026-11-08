// prism-toast: One polite live region that shows a short message for a few seconds.
import { Base, setAttribute } from "./base.js";

export class PrismToast extends Base {
  static tag = "prism-toast";
  static catalog = {
    purpose: "One polite live region that shows a short message for a few seconds.",
    options: [{ name: "show(message, { tone })", values: ["method"], default: "", description: "Shows a message, replacing any shown one." }],
    states: ["hidden"],
    keyboard: []
  };

  connectedCallback() {
    setAttribute(this, "role", "status");
    setAttribute(this, "aria-live", "polite");
  }
}
