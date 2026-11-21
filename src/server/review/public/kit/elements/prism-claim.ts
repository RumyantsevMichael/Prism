// prism-claim: a read-only claim in light DOM: which agent holds a slice, for what activity, and how long the claim has left, as an avatar,
// an inline line, or a strip with when it started and a lease meter. Its time words update every minute; it holds no control.
import { Base, make, setAttribute } from "./base.js";
import { agoText, everyMinute, exactTime, leaseLeft, sinceText, timeLeft } from "../claim-time.js";
import { unwatchShortening, watchShortening } from "../shorten.js";

const VARIANTS = ["avatar", "inline", "strip"];
const ACTIVITIES = ["design", "implementation"];

export class PrismClaim extends Base {
  declare stop: any;
  static tag = "prism-claim";
  static observedAttributes = ["label", "host", "model", "session-url", "session-label", "activity", "claimed-at", "renewed-at", "expires-at", "variant"];
  static catalog = {
    purpose: "Shows which agent holds a slice, for what activity, and how long its claim has left; an expired claim says how long ago it lapsed. It is read-only and holds no control.",
    options: [
      { name: "label", values: ["text"], default: "", description: "The holder's label, as the claim records it; every holder is an agent." },
      { name: "host", values: ["text"], default: "", description: "The harness the agent runs in, such as Claude Code or Codex, shown in place of the word Agent; without it the claim says Agent." },
      { name: "model", values: ["text"], default: "", description: "The model the claim records for its agent, shown after the harness or Agent as <host or Agent> · <model>; without it the claim names no model." },
      { name: "session-url", values: ["URL"], default: "", description: "An https address that opens the holder's session, such as a Claude Code on the web session; an inline claim and a strip then end with a Session link chip that opens it in a new tab, and an avatar shows none. Only the session's owner can open it, which the chip's tooltip says." },
      { name: "session-label", values: ["text"], default: "", description: "Where session-url opens the session, such as Claude Code on the web, named in the Session chip's tooltip; without it the tooltip says only that it opens the session." },
      { name: "activity", values: ACTIVITIES, default: "implementation", description: "What the holder is doing, in words with a facet in the design or build phase color." },
      { name: "claimed-at", values: ["time"], default: "", description: "When the claim started; a strip shows it as since <time>." },
      { name: "renewed-at", values: ["time"], default: "", description: "When the claim was last renewed; the strip's lease meter runs from it to expires-at." },
      { name: "expires-at", values: ["time"], default: "", description: "When the claim lapses; the time left shows in words and updates every minute." },
      { name: "variant", values: VARIANTS, default: "inline", description: "avatar shows only the avatar with the text as its tooltip, inline adds the holder, activity, and time left with the exact times as its tooltip, and strip is a full-width band that adds since, the last renewal, how long ago it was claimed, and the lease meter, with the exact times as its tooltip too." }
    ],
    states: ["avatar", "inline", "strip", "expired", "expired-strip", "model", "session", "session-strip"],
    keyboard: ["A claim takes no keys; an avatar claim's text is its accessible description, and a shortened inline claim joins the Tab order to show its full text."]
  };

  connectedCallback() {
    this.render();
    this.stop ??= everyMinute(() => this.update());
  }

  disconnectedCallback() {
    this.stop?.();
    this.stop = null;
    unwatchShortening(this);
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  get variant() {
    return VARIANTS.includes((this.getAttribute("variant") as any)) ? this.getAttribute("variant") : "inline";
  }

  get activity() {
    return ACTIVITIES.includes((this.getAttribute("activity") as any)) ? this.getAttribute("activity") : "implementation";
  }

  get label() {
    return (this.getAttribute("label") ?? "").trim();
  }

  /** What kind of holder this is: the harness the agent runs in when the claim names one, else Agent, and the model when the claim records one. */
  get kind() {
    const host = (this.getAttribute("host") ?? "").trim() || "Agent";
    const model = (this.getAttribute("model") ?? "").trim();
    return model ? `${host} · ${model}` : host;
  }

  /** The https address of the holder's session, or null. */
  get sessionUrl() {
    const value = (this.getAttribute("session-url") ?? "").trim();
    return /^https:\/\/[^\s"<>]+$/i.test(value) ? value : null;
  }

  /** A chip that opens the holder's session in a new tab, or null without a session address. */
  sessionChip() {
    const url = this.sessionUrl;
    if (!url) return null;
    const where = (this.getAttribute("session-label") ?? "").trim();
    const chip = make(this, "prism-chip", "prism-claim-session", { href: url, target: "_blank", label: where ? `Open session in ${where}` : "Open session", tip: `Opens this session${where ? ` in ${where}` : ""} in a new tab. Only the person whose session it is can open it.` });
    chip.append(make(this, "prism-icon", null, { slot: "start", name: "external" }), "Session");
    return chip;
  }

  /** The claim's text in one line: the holder, its harness or Agent and model, the activity, and the time left. */
  get tooltipText() {
    return [this.label, this.kind, this.activity, timeLeft(this.getAttribute("expires-at")).text].filter(Boolean).join(" · ");
  }

  render() {
    const variant = this.variant;
    (this as any).parts = {};
    const parts = (this as any).parts;
    parts.avatar = make(this, "prism-avatar", "prism-claim-avatar", { kind: "agent", size: variant === "strip" ? "lg" : variant === "inline" ? "sm" : null, name: this.label });
    const holder = () => {
      const line = make(this, "span", "prism-claim-holder");
      const name = make(this, "span", "prism-claim-name");
      name.textContent = this.label;
      const kind = make(this, "span", "prism-claim-kind");
      kind.textContent = this.kind;
      line.append(name, " ", kind);
      return line;
    };
    const activity = () => {
      const element = make(this, "span", "prism-claim-activity", { "data-activity": this.activity });
      const words = make(this, "span", "prism-claim-activity-words");
      words.textContent = this.activity;
      element.append(make(this, "span", "prism-claim-facet", { "aria-hidden": "true" }), words);
      return element;
    };
    parts.time = make(this, "span", "prism-claim-time");
    if (variant === "avatar") {
      this.replaceChildren(parts.avatar);
    } else if (variant === "inline") {
      const text = make(this, "span", "prism-claim-text");
      text.append(holder(), " ", activity(), " ", parts.time);
      this.replaceChildren(...[parts.avatar, text, this.sessionChip()].filter(Boolean));
      watchShortening((this as any), text);
    } else {
      const lines = make(this, "span", "prism-claim-lines");
      const first = make(this, "span", "prism-claim-line");
      const holds = make(this, "span", "prism-claim-holds");
      holds.textContent = "holds this slice for";
      first.append(holder(), " ", holds, " ", activity());
      // The report line: when the claim started and when its holder last renewed it, which is when the agent last checked in.
      parts.report = make(this, "span", "prism-claim-report");
      parts.since = make(this, "span", "prism-claim-since");
      parts.renewed = make(this, "span", "prism-claim-renewed");
      parts.report.append(parts.since, parts.renewed);
      const session = this.sessionChip();
      if (session) first.append(" ", session);
      lines.append(first, parts.report);
      const lease = make(this, "span", "prism-claim-lease");
      const words = make(this, "span", "prism-claim-lease-words");
      parts.claimed = make(this, "span", "prism-claim-ago");
      words.append(parts.time, parts.claimed);
      parts.meter = make(this, "prism-meter", "prism-claim-meter", { label: "Lease left" });
      lease.append(words, parts.meter);
      this.replaceChildren(parts.avatar, lines, lease);
    }
    if (variant !== "strip" && this.getAttribute("tabindex") === "0" && !this.hasAttribute("shortened")) this.removeAttribute("tabindex");
    if (variant !== "inline") unwatchShortening(this);
    this.update();
  }

  /** Writes the time words, the expired state, and the lease meter for the current time. */
  update() {
    const parts = (this as any).parts;
    if (!parts) return;
    const now = Date.now();
    const left = timeLeft(this.getAttribute("expires-at"), now);
    this.toggleAttribute("expired", left.expired);
    parts.time.textContent = left.text;
    parts.time.hidden = !left.text;
    const avatar = parts.avatar;
    avatar.toggleAttribute("expired", left.expired);
    avatar.toggleAttribute("live", !left.expired && Boolean(left.text));
    avatar.toggleAttribute("breathing", this.variant === "strip" && !left.expired && Boolean(left.text));
    if (this.variant === "avatar") {
      const text = this.tooltipText;
      setAttribute(this, "tip", text);
      setAttribute(avatar, "aria-description", text);
    } else {
      const times = [["Claimed", "claimed-at"], ["renewed", "renewed-at"], [left.expired ? "expired" : "expires", "expires-at"]].map(([word, name]) => exactTime(this.getAttribute(name)) && `${word} ${exactTime(this.getAttribute(name))}`).filter(Boolean);
      setAttribute(this, "tip", times.length ? times.join(", ") : null);
      // The exact times are the inline claim's and the strip's tooltip, so keyboard focus reaches them too.
      setAttribute(this, "tabindex", times.length ? "0" : null);
    }
    if (parts.since) parts.since.textContent = sinceText(this.getAttribute("claimed-at"), now);
    if (parts.renewed) {
      const renewed = agoText(this.getAttribute("renewed-at"), now);
      parts.renewed.textContent = renewed ? `last renewed ${renewed}` : "";
      parts.renewed.hidden = !renewed;
    }
    if (parts.claimed) {
      const claimed = agoText(this.getAttribute("claimed-at"), now);
      parts.claimed.textContent = claimed ? `claimed ${claimed}` : "";
      parts.claimed.hidden = !claimed;
    }
    if (parts.meter) {
      const lease = left.expired ? 0 : leaseLeft(this.getAttribute("renewed-at"), this.getAttribute("expires-at"), now);
      setAttribute(parts.meter, "value", lease === null ? null : String(lease));
      setAttribute(parts.meter, "tone", left.expired ? "warning" : null);
    }
    // A shown tooltip follows the words it shows.
    const tooltip = (this.ownerDocument as any).prismTooltip;
    if (tooltip?.target === this && this.hasAttribute("tip")) tooltip.textContent = this.getAttribute("tip");
  }
}
