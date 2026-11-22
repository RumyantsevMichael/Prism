// prism-hover-card: a card on frosted glass that shows what a link points to while the pointer rests on it, placed beside an anchor element and kept inside the window.
// Its head holds the children marked slot="actions" and stays in view, and its body holds every other child and scrolls when it is taller than the room beside the anchor.
// It renders in light DOM and is no dialog or landmark of its own, because it only repeats what its link leads to.
import { Base, distribute, make } from "./base.js";

function pixels(element: any, name: string) {
  return parseFloat(getComputedStyle(element).getPropertyValue(name)) || 0;
}

export class PrismHoverCard extends Base {
  declare head: any;
  declare body: any;
  static tag = "prism-hover-card";
  static catalog = {
    purpose: "A hover card on frosted glass that previews a link's target beside the link, such as a document's linked section; it scrolls when the content is taller than the room beside the link.",
    options: [
      { name: "replaceContent(...nodes)", values: ["nodes"], default: "", description: "Replaces the content at once, so the card can be placed right after." },
      { name: "wide", values: ["boolean"], default: "false", description: "Takes the card's full width whatever its content, as a document, file, or diagram preview does; otherwise the card fits its content." },
      { name: "hidden", values: ["boolean"], default: "false", description: "Whether the card is hidden; showAt(anchor) shows it beside an anchor element." },
      { name: "slot=\"actions\"", values: ["children"], default: "", description: "Controls that stay at the top of the card while its body scrolls, such as Show in side panel." }
    ],
    states: ["short", "long-content", "with-actions", "wide"],
    keyboard: ["The card takes no focus of its own; a control in its head is reached like any other control."]
  };

  connectedCallback() {
    if (this.body) return;
    this.head = make(this, "div", "prism-hover-card-head");
    this.body = make(this, "div", "prism-hover-card-body");
    this.append(this.head, this.body);
    (this as any).children$ = distribute(this, { actions: this.head, default: this.body }, [this.head, this.body]);
    this.syncHead();
    new MutationObserver(() => this.syncHead()).observe(this.head, { childList: true });
    this.body.addEventListener("scroll", () => this.syncFade(), { passive: true });
  }

  // The body's end fades while more content lies below it, since some systems hide a scrollbar until it is used.
  syncFade() {
    const more = this.body.scrollTop + this.body.clientHeight < this.body.scrollHeight - 1;
    this.body.toggleAttribute("data-more", more);
  }

  syncHead() {
    this.head.hidden = this.head.childElementCount === 0;
  }

  /** Replaces the card's content with nodes, each in the head when it is marked slot="actions" and in the body otherwise. */
  replaceContent(...nodes: any[]) {
    if (!this.body) this.connectedCallback();
    this.head.replaceChildren(...nodes.filter((node) => node.nodeType === 1 && node.getAttribute("slot") === "actions"));
    this.body.replaceChildren(...nodes.filter((node) => !(node.nodeType === 1 && node.getAttribute("slot") === "actions")));
    this.syncHead();
  }

  /** Shows the card beside anchor, at the top of its content. */
  showAt(anchor: any) {
    this.hidden = false;
    if (this.body) this.body.scrollTop = 0;
    this.place(anchor);
  }

  // Below the anchor, or above it when there is more room there, never over it, starting at the anchor's start and inside the window;
  // the card's height is capped to the room on the side it takes, and its body scrolls within that.
  place(anchor: any) {
    if (this.hidden || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const gap = pixels(this, "--prism-space-3");
    this.style.removeProperty("max-height");
    const below = globalThis.innerHeight - rect.bottom - 2 * gap;
    const above = rect.top - 2 * gap;
    let box = this.getBoundingClientRect();
    const downward = box.height <= below || below >= above;
    const room = Math.max(0, downward ? below : above);
    if (box.height > room) this.style.setProperty("max-height", `${room}px`);
    box = this.getBoundingClientRect();
    const top = downward ? rect.bottom + gap : rect.top - gap - box.height;
    const left = Math.min(Math.max(gap, rect.left), Math.max(gap, globalThis.innerWidth - gap - box.width));
    this.style.setProperty("top", `${Math.max(gap, top)}px`);
    this.style.setProperty("left", `${left}px`);
    this.syncFade();
  }
}
