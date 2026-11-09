// The page for a link the review app cannot open defines only the kit element it shows, since it has no project to read preferences or records from.
import { PrismPanel } from "./kit/elements/prism-panel.js";

if (!customElements.get(PrismPanel.tag)) customElements.define(PrismPanel.tag, PrismPanel);
