// The review app's kit: one prism-* custom element per kind of control, defined from KIT_ELEMENTS.
// The module imports without a DOM, so tests and the catalog can read KIT_ELEMENTS; in a page it loads the shadow stylesheets once, defines every element,
// adds the page's one tooltip, and keeps the appearance in step with the system. appearance.js then applies the review app's stored choice.
import { startPreferences } from "./preferences.js";
import { loadStyles } from "./elements/base.js";
import { PrismButton } from "./elements/prism-button.js";
import { PrismIcon } from "./elements/prism-icon.js";
import { PrismChip } from "./elements/prism-chip.js";
import { PrismBadge } from "./elements/prism-badge.js";
import { PrismTab } from "./elements/prism-tab.js";
import { PrismTabs } from "./elements/prism-tabs.js";
import { PrismDocTab } from "./elements/prism-doc-tab.js";
import { PrismDocTabs } from "./elements/prism-doc-tabs.js";
import { PrismMenu } from "./elements/prism-menu.js";
import { PrismMenuGroup } from "./elements/prism-menu-group.js";
import { PrismMenuItem } from "./elements/prism-menu-item.js";
import { installTooltip, PrismTooltip } from "./elements/prism-tooltip.js";
import { PrismField } from "./elements/prism-field.js";
import { PrismOption } from "./elements/prism-option.js";
import { PrismChoice } from "./elements/prism-choice.js";
import { PrismChoiceOption } from "./elements/prism-choice-option.js";
import { PrismStat } from "./elements/prism-stat.js";
import { PrismMeter } from "./elements/prism-meter.js";
import { PrismSpinner } from "./elements/prism-spinner.js";
import { PrismAvatar } from "./elements/prism-avatar.js";
import { PrismPanel } from "./elements/prism-panel.js";
import { PrismTree } from "./elements/prism-tree.js";
import { PrismTreeItem } from "./elements/prism-tree-item.js";
import { PrismRail } from "./elements/prism-rail.js";
import { PrismRailItem } from "./elements/prism-rail-item.js";
import { PrismPlaceHead } from "./elements/prism-place-head.js";
import { PrismListbox } from "./elements/prism-listbox.js";
import { PrismListItem } from "./elements/prism-list-item.js";
import { PrismDialog } from "./elements/prism-dialog.js";
import { PrismPopover } from "./elements/prism-popover.js";
import { PrismDisclosure } from "./elements/prism-disclosure.js";
import { PrismEmptyState } from "./elements/prism-empty-state.js";
import { PrismBanner } from "./elements/prism-banner.js";
import { PrismToast } from "./elements/prism-toast.js";
import { PrismClaim } from "./elements/prism-claim.js";
import { PrismStepper } from "./elements/prism-stepper.js";
import { PrismStep } from "./elements/prism-step.js";
import { PrismBreadcrumbs } from "./elements/prism-breadcrumbs.js";
import { PrismDoc } from "./elements/prism-doc.js";
import { PrismCode } from "./elements/prism-code.js";
import { PrismInbox } from "./elements/prism-inbox.js";
import { PrismInboxItem } from "./elements/prism-inbox-item.js";
import { PrismPhase } from "./elements/prism-phase.js";
import { PrismPhaseBar } from "./elements/prism-phase-bar.js";
import { PrismState } from "./elements/prism-state.js";
import { PrismKbd } from "./elements/prism-kbd.js";

/**
 * Every kit element class; each carries a static `tag` and a static `catalog` of
 * `{ purpose, options: [{ name, values, default, description }], states: [<state name>], keyboard: [<sentence>] }`.
 * A class with a static `styles` list renders in shadow DOM and adopts those stylesheets from elements/; the others render in light DOM, styled by kit.css.
 */
export const KIT_ELEMENTS = [
  PrismButton,
  PrismIcon,
  PrismChip,
  PrismBadge,
  PrismKbd,
  PrismTab,
  PrismMenuItem,
  PrismTooltip,
  PrismStat,
  PrismMeter,
  PrismSpinner,
  PrismAvatar,
  PrismTabs,
  PrismDocTab,
  PrismDocTabs,
  PrismMenu,
  PrismMenuGroup,
  PrismField,
  PrismOption,
  PrismChoice,
  PrismChoiceOption,
  PrismPanel,
  PrismTree,
  PrismTreeItem,
  PrismRail,
  PrismRailItem,
  PrismPlaceHead,
  PrismListbox,
  PrismListItem,
  PrismDialog,
  PrismPopover,
  PrismDisclosure,
  PrismEmptyState,
  PrismBanner,
  PrismToast,
  PrismClaim,
  PrismStepper,
  PrismStep,
  PrismBreadcrumbs,
  PrismDoc,
  PrismCode,
  PrismInbox,
  PrismInboxItem,
  PrismPhase,
  PrismPhaseBar,
  PrismState
];

/** Defines each kit element once; a second call, or an element that is already defined, changes nothing. */
export function defineKit(registry = globalThis.customElements) {
  if (!registry) return;
  for (const element of KIT_ELEMENTS) {
    if (!registry.get(element.tag)) registry.define(element.tag, element);
  }
}

if (globalThis.document) {
  startPreferences();
  // Every shadow stylesheet is loaded before the elements are defined, so an element never draws unstyled.
  // The module does not wait for them, so a page that imports it, such as the catalog, draws its own markup before the load event.
  loadStyles(KIT_ELEMENTS.flatMap((element) => element.styles ?? [])).then(() => {
    defineKit();
    installTooltip(globalThis.document);
  });
}
