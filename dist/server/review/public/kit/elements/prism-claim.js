// prism-claim: Shows which agent holds a slice, for what activity, and how long its claim has left.
import { Base, setAttribute } from "./base.js";

export class PrismClaim extends Base {
  static tag = "prism-claim";
  static catalog = {
    purpose: "Shows which agent holds a slice, for what activity, and how long its claim has left.",
    options: [{ name: "label", values: ["text"], default: "", description: "The holder label." }, { name: "activity", values: ["design", "implementation"], default: "implementation", description: "What the holder is doing." }, { name: "expires-at", values: ["time"], default: "", description: "When the claim lapses." }, { name: "variant", values: ["avatar", "inline", "strip"], default: "inline", description: "How much of the claim shows." }],
    states: ["inline"],
    keyboard: []
  };

  connectedCallback() {
    this.textContent = this.textContent.trim() || `${this.getAttribute("label") ?? ""} Agent`;
  }
}
