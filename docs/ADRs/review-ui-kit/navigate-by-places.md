# Navigate the review app by places

Status: Accepted
Created: 2026-11-09

## Requirements

- [review-app-places.md§1](../../requirements/review-app-places.md#1)
- [review-app-places.md§2](../../requirements/review-app-places.md#2)
- [review-app-places.md§3](../../requirements/review-app-places.md#3)
- [review-app-places.md§6](../../requirements/review-app-places.md#6)
- [review-app-places.md§8](../../requirements/review-app-places.md#8)
- [review-app-places.md§9](../../requirements/review-app-places.md#9)
- [review-app-places.md§23](../../requirements/review-app-places.md#23)
- [review-app-places.md§24](../../requirements/review-app-places.md#24)
- [review-app-places.md§34](../../requirements/review-app-places.md#34)
- [review-app-places.md§36](../../requirements/review-app-places.md#36)

## Problem

The navigation clause of [own-ui-kit.md](own-ui-kit.md) says that navigation has one sidebar, which becomes a drawer on narrow windows, and that pages are reached through back and forward rather than a strip of open tabs.
The strip of open documents came back after the UI kit shipped without it, because people hold several documents open at once and agents present several artifacts together.
The single sidebar also mixes the work in flight with the whole library of records, so in a large project it grows to hundreds of rows that help nobody find what matters to the work in hand.
The person wears different hats, such as engineer, tech lead, or product owner, and each hat comes to the app to do a different thing.

## Decision

This decision supersedes the navigation clause of [own-ui-kit.md](own-ui-kit.md) and leaves its other clauses in force.
Navigation MUST be organized into a small fixed set of places, each of which answers one question the person brings: what waits on me, what is being built, what is planned, what the records say, and what already shipped.
On a wide window an icon rail at the left edge MUST switch between the places, and the sidebar MUST show the navigation of the current place only.
On a narrow window the same rail and the current place's sidebar MUST open together as one drawer, so the model is the same at every width.
The sidebar MUST change only when the person chooses a place, never because the open page changed, and every page that belongs to a place MUST name that place first in its trail.
The strip of open documents MUST stay as the way to hold several pages open, beside the page bar's back and forward through visited pages.
Every navigation entry that leads to a page or a filtered list MUST be a link to its own address, so the browser's own ways to open and copy a link keep working.
Roles MUST stay hats that any person can wear, and no place MAY depend on knowing who is viewing.
A place, filter, or entry point that Prism cannot yet fill MUST NOT appear, not even as a disabled control.
A screen that has an approved mockup MUST be compared with it by rendering both and comparing their structure, geometry, and design values, and a difference MUST fail that comparison.

## Rationale

A place per question keeps each sidebar short however large the project grows, because no single list holds every record.
An IDE-like rail is familiar to the engineers and tech leads who come first, and it lets the sidebar stay where the person put it while they follow links between places.
Tabs and back and forward answer different needs: tabs hold a working set, and history retraces steps, so dropping either loses a feature people used.
Real links cost nothing and keep middle click, new windows, and copied addresses working for every entry.
Comparing rendered screens with the mockup is the only check that catches a screen that works and still looks nothing like its design.

## Alternatives

- One sidebar with collapsible sections: it still lists every record, so a large project stays a long scroll.
- A switch between a work view and a library view in the sidebar's head: two places are too few for the hats, and the switch hides that more places exist.
- Role-based interfaces with accounts: the review app does not know who is viewing, and one person wears several hats in a day.
- A sidebar that follows the open page: following a link from Attention would take Attention away from the person who was working through it.
- No strip of open tabs, as the UI kit decided: people lost the working set they held open and the artifacts an agent presented together.

## Consequences

- The sidebar's contents depend on the chosen place, so tests and scripts that reached a page through one long sidebar now choose a place first.
- Shipped and superseded work leaves the work list, so finding it takes one more click through History.
- Records are no longer listed one by one in the sidebar, so a person who browsed the whole list now searches or opens a list page.
- The mockup comparison costs a rendering run per screen change and needs a browser, which continuous integration already installs.
- The comparison checks structure and measured geometry within tolerances rather than pixels, so a difference smaller than its tolerances passes.

## Mechanism

The review page keeps the current place in browser storage and renders the rail, the place's head, and the place's own navigation from the navigation data the review server already sends.
The server names the place each page belongs to with the page's trail, and the page bar draws that place as the trail's first link.
Collapsing the sidebar hides the place's navigation and keeps the rail, and choosing a place on a collapsed rail shows the sidebar again.
Below the drawer width the rail moves with the sidebar into the navigation drawer, and the top bar keeps the Attention bell with its count, since the rail is hidden while the drawer is closed.
The mockup comparison renders each scene of the approved mockup and the demo app in the same state, size, and theme, reads from each a common outline of the rail, the place head, the sidebar's groups and rows, and the top bar's landmark controls, measures named boxes and design values, and fails on any difference beyond its tolerances.

## Decision Log
