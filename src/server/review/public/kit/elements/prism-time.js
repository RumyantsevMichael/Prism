// prism-time: a time in words, such as 5 min ago or 30 min left, in light DOM, that keeps its words current every minute while it is shown.
import { Base, setAttribute } from "./base.js";
import { agoText, everyMinute, exactTime, timeLeft } from "../claim-time.js";

const FORMATS = ["ago", "short", "left"];

/** The words of a time in a format: `ago` as 5 min ago, `short` as 5 min or now, `left` as 30 min left or Expired 4 min ago. */
export function timeWords(datetime, format = "ago", now = Date.now()) {
  if (format === "left") return timeLeft(datetime, now).text;
  const ago = agoText(datetime, now);
  if (format === "short") return ago === "just now" ? "now" : ago.replace(/ ago$/, "");
  return ago;
}

export class PrismTime extends Base {
  static tag = "prism-time";
  static observedAttributes = ["datetime", "format"];
  static catalog = {
    purpose: "A time in words, such as how long ago something happened or how long a lease has left; its words update every minute without a reload, and its tooltip gives the exact date and time.",
    options: [
      { name: "datetime", values: ["time"], default: "", description: "The time it names, as an ISO 8601 timestamp; without a valid time it shows nothing." },
      { name: "format", values: FORMATS, default: "ago", description: "ago reads 5 min ago or just now, short reads 5 min or now for a narrow column, and left reads 30 min left, or Expired 4 min ago once the time has passed." }
    ],
    states: ["ago", "short", "left", "expired"],
    keyboard: ["A time takes no keys; it is text."]
  };

  connectedCallback() {
    this.update();
    this.stop ??= everyMinute(() => this.update());
  }

  disconnectedCallback() {
    this.stop?.();
    this.stop = null;
  }

  attributeChangedCallback() {
    if (this.isConnected) this.update();
  }

  get format() {
    return FORMATS.includes(this.getAttribute("format")) ? this.getAttribute("format") : "ago";
  }

  update() {
    const datetime = this.getAttribute("datetime") ?? "";
    const words = timeWords(datetime, this.format);
    if (this.textContent !== words) this.textContent = words;
    const left = this.format === "left" ? timeLeft(datetime) : null;
    this.toggleAttribute("expired", Boolean(left?.expired));
    setAttribute(this, "tip", exactTime(datetime) || null);
  }
}
