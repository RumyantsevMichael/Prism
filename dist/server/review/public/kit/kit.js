// Generated from src/server/review/public/kit/kit.ts by scripts/native-build/compile.mjs.
import { startPreferences } from "./preferences.js";
import { loadStyles } from "./elements/base.js";
import { PrismButton } from "./elements/prism-button.js";
import { PrismIcon } from "./elements/prism-icon.js";
import { PrismChip } from "./elements/prism-chip.js";
import { PrismBadge } from "./elements/prism-badge.js";
import { PrismTab } from "./elements/prism-tab.js";
import { PrismTabs } from "./elements/prism-tabs.js";
import { PrismDocTab } from "./elements/prism-doc-tab.js";
import { PrismDocTabGroup } from "./elements/prism-doc-tab-group.js";
import { PrismDocTabs } from "./elements/prism-doc-tabs.js";
import { PrismCanvas } from "./elements/prism-canvas.js";
import { PrismMenu } from "./elements/prism-menu.js";
import { PrismMenuGroup } from "./elements/prism-menu-group.js";
import { PrismMenuItem } from "./elements/prism-menu-item.js";
import { installTooltip, PrismTooltip } from "./elements/prism-tooltip.js";
import { PrismField } from "./elements/prism-field.js";
import { PrismOption } from "./elements/prism-option.js";
import { PrismChoice } from "./elements/prism-choice.js";
import { PrismChoiceOption } from "./elements/prism-choice-option.js";
import { PrismSegmented } from "./elements/prism-segmented.js";
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
import { PrismHoverCard } from "./elements/prism-hover-card.js";
import { PrismPicker } from "./elements/prism-picker.js";
import { PrismDisclosure } from "./elements/prism-disclosure.js";
import { PrismEmptyState } from "./elements/prism-empty-state.js";
import { PrismBanner } from "./elements/prism-banner.js";
import { PrismToast } from "./elements/prism-toast.js";
import { PrismClaim } from "./elements/prism-claim.js";
import { PrismTime } from "./elements/prism-time.js";
import { PrismStepper } from "./elements/prism-stepper.js";
import { PrismStep } from "./elements/prism-step.js";
import { PrismBreadcrumbs } from "./elements/prism-breadcrumbs.js";
import { PrismDoc } from "./elements/prism-doc.js";
import { PrismCode } from "./elements/prism-code.js";
import { PrismInbox } from "./elements/prism-inbox.js";
import { PrismInboxItem } from "./elements/prism-inbox-item.js";
import { PrismRow } from "./elements/prism-row.js";
import { PrismCountLink } from "./elements/prism-count-link.js";
import { PrismAgentSummary } from "./elements/prism-agent-summary.js";
import { PrismPageSub } from "./elements/prism-page-sub.js";
import { PrismLibTable } from "./elements/prism-lib-table.js";
import { PrismPhase } from "./elements/prism-phase.js";
import { PrismSliceBar } from "./elements/prism-slice-bar.js";
import { PrismSeverity } from "./elements/prism-severity.js";
import { PrismStatus } from "./elements/prism-status.js";
import { PrismResizer } from "./elements/prism-resizer.js";
import { PrismKbd } from "./elements/prism-kbd.js";
import { PrismTable } from "./elements/prism-table.js";
import { PrismMaximize } from "./elements/prism-maximize.js";
import { PrismContents } from "./elements/prism-contents.js";
const KIT_ELEMENTS = [
  PrismButton,
  PrismIcon,
  PrismChip,
  PrismBadge,
  PrismKbd,
  PrismTable,
  PrismTab,
  PrismMenuItem,
  PrismTooltip,
  PrismStat,
  PrismMeter,
  PrismSpinner,
  PrismAvatar,
  PrismTabs,
  PrismDocTab,
  PrismDocTabGroup,
  PrismDocTabs,
  PrismMenu,
  PrismMenuGroup,
  PrismField,
  PrismOption,
  PrismChoice,
  PrismChoiceOption,
  PrismSegmented,
  PrismMaximize,
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
  PrismHoverCard,
  PrismPicker,
  PrismDisclosure,
  PrismEmptyState,
  PrismBanner,
  PrismToast,
  PrismClaim,
  PrismTime,
  PrismStepper,
  PrismStep,
  PrismBreadcrumbs,
  PrismDoc,
  PrismCanvas,
  PrismContents,
  PrismCode,
  PrismInbox,
  PrismInboxItem,
  PrismRow,
  PrismCountLink,
  PrismAgentSummary,
  PrismPageSub,
  PrismLibTable,
  PrismPhase,
  PrismSliceBar,
  PrismSeverity,
  PrismStatus,
  PrismResizer
];
function defineKit(registry = globalThis.customElements) {
  if (!registry) return;
  for (const element of KIT_ELEMENTS) {
    if (!registry.get(element.tag)) registry.define(element.tag, element);
  }
}
if (globalThis.document) {
  startPreferences();
  loadStyles(KIT_ELEMENTS.flatMap((element) => element.styles ?? [])).then(() => {
    defineKit();
    installTooltip(globalThis.document);
  });
}
export {
  KIT_ELEMENTS,
  defineKit
};
