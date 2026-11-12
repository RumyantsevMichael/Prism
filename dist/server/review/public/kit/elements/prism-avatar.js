// prism-avatar: an agent as a rounded square with the agent glyph, or a person as a circle with initials, with the live dot and the expired outline.
import { Base, escapeHtml, setAttribute, shadow } from "./base.js";

export class PrismAvatar extends Base {
  static tag = "prism-avatar";
  static styles = ["prism-avatar.css"];
  static observedAttributes = ["kind", "name", "hue", "live", "breathing", "expired", "size"];
  static catalog = {
    purpose: "Shows who holds something: an agent as a rounded square with the agent glyph, or a person as a circle with initials; it also marks a workspace as an accent tile with its first letter.",
    options: [
      { name: "kind", values: ["agent", "person", "workspace"], default: "agent", description: "Whether the holder is an agent or a person, or a workspace or project, which the top bar's project button shows." },
      { name: "name", values: ["text"], default: "", description: "The holder's name; an agent's accessible name adds (agent)." },
      { name: "size", values: ["sm", "md", "lg"], default: "md", description: "From --prism-avatar-size-sm, --prism-avatar-size, and --prism-avatar-size-lg." },
      { name: "hue", values: ["1", "2", "3", "4"], default: "1", description: "A person's color." },
      { name: "live", values: ["boolean"], default: "false", description: "Adds the live dot." },
      { name: "breathing", values: ["boolean"], default: "false", description: "Makes the live dot pulse." },
      { name: "expired", values: ["boolean"], default: "false", description: "Draws the avatar hollow with a dashed outline and no dot." }
    ],
    states: ["agent", "person", "workspace", "live", "expired"],
    keyboard: []
  };

  constructor() {
    super();
    this.root = shadow(this, PrismAvatar.styles, "");
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  render() {
    const kind = this.getAttribute("kind");
    const person = kind === "person";
    const workspace = kind === "workspace";
    const name = (this.getAttribute("name") ?? "").trim();
    const initials = workspace ? ([...name][0] ?? "").toUpperCase() : name.split(/\s+/).slice(0, 2).map((word) => [...word][0] ?? "").join("").toUpperCase();
    const face = person || workspace ? `<span class="initials">${escapeHtml(initials)}</span>` : `<prism-icon name="agent" size="xs"></prism-icon>`;
    const dot = this.hasAttribute("live") && !this.hasAttribute("expired") ? `<span class="dot" part="dot"></span>` : "";
    this.root.innerHTML = `<span class="face" part="face" aria-hidden="true">${face}</span>${dot}`;
    setAttribute(this, "role", "img");
    setAttribute(this, "aria-label", name ? (person || workspace ? name : `${name} (agent)`) : null);
  }
}
