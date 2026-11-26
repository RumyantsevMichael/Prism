// prism-inline-note: a short note in a tone, with a glyph before its text, that sits in the flow of a view and wraps within its container, in light DOM.
import { Base, setAttribute } from "./base.js";

const TONES = ["info", "warning"];

export class PrismInlineNote extends Base {
  static tag = "prism-inline-note";
  static catalog = {
    purpose: "A one-line note in the flow of a view, such as a conflict between two versions, in a tone with a glyph before its text; a long text wraps within its container and never overflows it.",
    options: [
      { name: "tone", values: TONES, default: "info", description: "The note's tone, which colors its glyph and its text." },
      { name: "slot=\"start\"", values: ["prism-icon"], default: "", description: "The glyph before the text, such as the warning or info icon." }
    ],
    states: ["warning", "info"],
    keyboard: ["A note takes no keys; links inside it take their own."]
  };

  connectedCallback() {
    setAttribute(this, "role", "note");
  }
}
