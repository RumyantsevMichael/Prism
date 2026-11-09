// prism-choice-option: one option of a prism-choice, a native radio input drawn by an indicator, with a title and a description from slot="detail".
import { Base, setAttribute, uniqueId } from "./base.js";

export class PrismChoiceOption extends Base {
  static tag = "prism-choice-option";
  static observedAttributes = ["value", "disabled", "tone"];
  static catalog = {
    purpose: "One option of a prism-choice: a native radio input, drawn by an indicator, with its title and a description from slot=\"detail\".",
    options: [
      { name: "value", values: ["text"], default: "", description: "The value the choice takes when this option is chosen." },
      { name: "tone", values: ["neutral", "danger"], default: "neutral", description: "danger marks an option that rejects or removes." },
      { name: "disabled", values: ["boolean"], default: "false", description: "The option cannot be chosen and arrow keys skip it." },
      { name: "slot=\"detail\"", values: ["children"], default: "", description: "A description shown below the title." }
    ],
    states: ["unchecked", "checked", "danger", "disabled", "detail"],
    keyboard: ["Inside a prism-choice, the arrow keys move the choice to the next or previous enabled option."]
  };

  connectedCallback() {
    if (!this.input) this.build();
    this.sync();
  }

  attributeChangedCallback() {
    this.sync();
  }

  get value() {
    return this.getAttribute("value") ?? "";
  }

  get checked() {
    return Boolean(this.input?.checked);
  }

  set checked(value) {
    if (this.input) this.input.checked = Boolean(value);
  }

  build() {
    const document = this.ownerDocument;
    const id = uniqueId("prism-choice-option");
    const box = document.createElement("label");
    box.className = "prism-choice-box";
    const input = document.createElement("input");
    input.type = "radio";
    input.className = "prism-choice-input";
    input.id = id;
    const indicator = document.createElement("span");
    indicator.className = "prism-choice-indicator";
    indicator.setAttribute("data-indicator", "");
    indicator.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "prism-choice-title";
    title.id = `${id}-title`;
    const detail = document.createElement("span");
    detail.className = "prism-choice-detail";
    detail.id = `${id}-detail`;
    for (const node of [...this.childNodes]) {
      if (node.nodeType === 1 && node.getAttribute("slot") === "detail") detail.append(node);
      else title.append(node);
    }
    box.append(input, indicator, title);
    if (detail.childNodes.length) {
      box.append(detail);
      input.setAttribute("aria-describedby", detail.id);
    }
    input.setAttribute("aria-labelledby", title.id);
    this.append(box);
    this.input = input;
  }

  sync() {
    const input = this.input;
    if (!input) return;
    const choice = this.closest("prism-choice");
    let name = choice?.getAttribute("name");
    if (choice && !name) {
      name = uniqueId("prism-choice");
      choice.setAttribute("name", name);
    }
    setAttribute(input, "name", name ?? null);
    input.value = this.value;
    input.disabled = this.hasAttribute("disabled");
    const wanted = choice?.getAttribute("value");
    if (wanted !== null && wanted !== undefined && wanted === this.value && !choice.touched) input.checked = true;
  }
}
