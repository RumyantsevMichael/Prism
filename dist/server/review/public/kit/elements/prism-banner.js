// Generated from src/server/review/public/kit/elements/prism-banner.ts by scripts/native-build/compile.mjs.
import { Base, distribute, make, setAttribute } from "./base.js";
const TONES = ["info", "warning", "danger", "success"];
const ICONS = { info: "info", warning: "warning", danger: "warning", success: "check" };
class PrismBanner extends Base {
  static tag = "prism-banner";
  static observedAttributes = ["tone", "heading", "dismissible"];
  static catalog = {
    purpose: "A message across the top of a place, in a tone; a danger banner is an alert and the others are a status.",
    options: [
      { name: "tone", values: TONES, default: "info", description: "The message's tone; danger has the role alert and the others status." },
      { name: "heading", values: ["text"], default: "", description: "The message's heading." },
      { name: "dismissible", values: ["boolean"], default: "false", description: "Adds a button named Dismiss that sends prism-dismiss and hides the banner unless a listener prevents it." }
    ],
    states: ["info", "warning", "danger", "success", "dismissible"],
    keyboard: ["The Dismiss button takes Enter and Space."]
  };
  connectedCallback() {
    if (!this.headingElement) this.build();
    this.sync();
  }
  attributeChangedCallback() {
    if (this.headingElement) this.sync();
  }
  build() {
    this.icon = make(this, "prism-icon", "prism-banner-icon");
    this.text = make(this, "div", "prism-banner-text");
    this.headingElement = make(this, "p", "prism-banner-heading");
    this.body = make(this, "div", "prism-banner-body");
    this.text.append(this.headingElement, this.body);
    this.prepend(this.icon, this.text);
    this.children$ = distribute(this, { default: this.body }, [this.icon, this.text, this.dismissButton].filter(Boolean));
  }
  get tone() {
    return TONES.includes(this.getAttribute("tone")) ? this.getAttribute("tone") : "info";
  }
  sync() {
    setAttribute(this, "role", this.tone === "danger" ? "alert" : "status");
    setAttribute(this.icon, "name", ICONS[this.tone]);
    const heading = this.getAttribute("heading") ?? "";
    this.headingElement.textContent = heading;
    this.headingElement.hidden = !heading;
    const dismissible = this.hasAttribute("dismissible");
    if (dismissible && !this.dismissButton) {
      this.dismissButton = make(this, "prism-button", "prism-banner-dismiss", { variant: "ghost", size: "sm", label: "Dismiss" });
      this.dismissButton.append(make(this, "prism-icon", "", { name: "close" }));
      this.dismissButton.addEventListener("click", () => {
        const event = new CustomEvent("prism-dismiss", { bubbles: true, composed: true, cancelable: true, detail: {} });
        if (this.dispatchEvent(event)) this.hidden = true;
      });
      this.children$.disconnect();
      this.append(this.dismissButton);
      this.children$ = distribute(this, { default: this.body }, [this.icon, this.text, this.dismissButton]);
    } else if (!dismissible && this.dismissButton) {
      this.dismissButton.remove();
      this.dismissButton = null;
    }
  }
}
export {
  PrismBanner
};
