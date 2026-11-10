// prism-doc-tab: one open document of a prism-doc-tabs strip, with its select part, a Keep button while it is the preview, and a close button.
import { Base, setAttribute, shadow } from "./base.js";

// The parts the strip tells apart when a click, a double click, or a key lands in a tab.
const ACTIONS = { keep: "keep", close: "close" };

export class PrismDocTab extends Base {
  static tag = "prism-doc-tab";
  static styles = ["prism-doc-tab.css"];
  static observedAttributes = ["selected", "preview", "agent", "missing", "label", "current", "group"];
  static catalog = {
    purpose: "One open document of a prism-doc-tabs strip: its title, an italic preview tab with a Keep button, a mark when an agent presented it, a dimmed and struck-through title when its target is gone, and a close button.",
    options: [
      { name: "value", values: ["text"], default: "", description: "The page the tab opens, sent in the strip's events." },
      { name: "selected", values: ["boolean"], default: "false", description: "The tab of the page that shows, exposed as aria-selected and joined to the page below it." },
      { name: "preview", values: ["boolean"], default: "false", description: "The one preview tab, which the next ordinary open replaces: its title is italic and it offers Keep." },
      { name: "agent", values: ["boolean"], default: "false", description: "An agent presented the page: the tab carries the agent mark and says so to assistive technology." },
      { name: "missing", values: ["boolean"], default: "false", description: "The tab's file or record is gone: its title is dimmed and struck through and says so to assistive technology." },
      { name: "label", values: ["text"], default: "", description: "The page's title, which the close button's name and the Keep button's tip use; the tab's text is its visible title." },
      { name: "tip", values: ["text"], default: "", description: "The full title and what the tab's state means, shown by the kit tooltip on hover and keyboard focus." },
      { name: "group", values: ["text"], default: "", description: "The name of the tab group the tab belongs to, set by the strip and told to assistive technology." },
      { name: "group-tone", values: ["1", "2", "3", "4", "5", "6"], default: "", description: "The group's color, which the strip sets and the tab draws as a line along its bottom." }
    ],
    states: ["kept", "preview", "agent", "missing", "grouped"],
    keyboard: ["Inside prism-doc-tabs, arrow keys move between tabs and Enter or Space opens one.", "Tab from the focused tab reaches its Keep and close buttons."]
  };

  constructor() {
    super();
    this.root = shadow(this, PrismDocTab.styles, `<div class="tab" part="tab">
      <span class="select" part="select" role="tab" tabindex="-1" aria-selected="false"><prism-icon class="mark" name="agent" size="xs" hidden></prism-icon><span class="text"><slot></slot></span><span class="note"></span></span>
      <prism-button class="keep" data-action="${ACTIONS.keep}" size="sm" variant="ghost" hidden>Keep</prism-button>
      <prism-button class="close" data-action="${ACTIONS.close}" size="sm" variant="ghost" tip="Close (middle-click)"><prism-icon name="close" size="xs"></prism-icon></prism-button>
    </div>`);
    this.select = this.root.querySelector(".select");
    this.keep = this.root.querySelector(".keep");
    this.close = this.root.querySelector(".close");
    this.note = this.root.querySelector(".note");
    this.mark = this.root.querySelector(".mark");
  }

  connectedCallback() {
    this.sync();
  }

  attributeChangedCallback() {
    this.sync();
  }

  get value() {
    return this.getAttribute("value") ?? "";
  }

  get label() {
    return this.getAttribute("label") || this.textContent.replace(/\s+/g, " ").trim();
  }

  /** The control an event in this tab concerns: "keep" or "close" for its buttons, and "select" for the rest of the tab. */
  partOf(event) {
    const action = event.composedPath().find((node) => node.dataset?.action && this.root.contains(node));
    return action ? action.dataset.action : "select";
  }

  focus(options) {
    this.select.focus(options);
  }

  sync() {
    const selected = this.hasAttribute("selected");
    const preview = this.hasAttribute("preview");
    const agent = this.hasAttribute("agent");
    const missing = this.hasAttribute("missing");
    const current = this.hasAttribute("current");
    const label = this.label;
    setAttribute(this.select, "aria-selected", String(selected));
    setAttribute(this.select, "tabindex", current ? "0" : "-1");
    this.mark.hidden = !agent;
    this.keep.hidden = !preview;
    // Only the focused or selected tab's buttons are in the Tab order, so Tab leaves the strip after the one tab it is on.
    for (const button of [this.keep, this.close]) setAttribute(button, "tabindex", current ? null : "-1");
    // Keep shows its word, which is its name; its tip says what it keeps.
    setAttribute(this.keep, "tip", `Keep ${label} open`);
    setAttribute(this.close, "label", `Close ${label}`);
    const group = this.getAttribute("group");
    this.note.textContent = [missing ? ", no longer exists" : "", agent ? ", presented by the agent" : "", preview ? ", preview" : "", group ? `, in group ${group}` : ""].join("");
  }
}
