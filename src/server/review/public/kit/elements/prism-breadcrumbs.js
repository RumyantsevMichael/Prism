// prism-breadcrumbs: The trail of the current page place, as a breadcrumb navigation.
import { Base, setAttribute } from "./base.js";

export class PrismBreadcrumbs extends Base {
  static tag = "prism-breadcrumbs";
  static catalog = {
    purpose: "The trail of the current page place, as a breadcrumb navigation.",
    options: [],
    states: ["default"],
    keyboard: []
  };

  connectedCallback() {
    setAttribute(this, "role", "navigation");
    setAttribute(this, "aria-label", "Breadcrumb");
  }
}
