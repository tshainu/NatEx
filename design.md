# NatEx — Design System

Operational software for a Sri Lankan courier business. Four web portals (ops, merchant, finance, admin) + one mobile app for field staff. This is a **tool**, not a marketing site: density, scan-ability and status legibility beat decoration. Everything here applies to web, mobile and desktop.

## Product feel

Airline-operations-console energy. Dark, calm chrome; data in high contrast; colour reserved *entirely* for parcel status and money state. A dispatcher watches this screen for eight hours — nothing may shimmer, bounce or pulse without a reason.

## Colour

Deep ink navy shell with emerald as the single brand accent (changed from amber on 2026-10-03 at the client's request). Status colours are semantic and never reused for decoration.

```
--ink-900   #0A1626   deepest shell / ops board background
--ink-800   #0F2033   sidebar, table header
--ink-700   #16304A   raised card on dark
--ink-600   #1E4266   border on dark
--brand     #10B981   emerald — NatEx accent, primary action, active nav
--brand-ink #047857   emerald text on light surfaces
--paper     #F7F8FA   light portal background (merchant/finance/admin)
--paper-card#FFFFFF
--line      #E3E7ED
--text-hi   #F4F7FB   on dark
--text-lo   #8FA3B8   muted on dark
--text-dark #0C1B2A   on light
```

**Status palette — locked, used identically in web and mobile:**

| Meaning | Statuses | Colour |
|---|---|---|
| Created, not yet moving | Booked | slate `#64748B` |
| In custody, moving | PickedUp, AtOriginHub, Bagged, InTransit, AtDestHub, OutForDelivery | sky `#0EA5E9` (was amber; moved off amber with the 2026-10-03 rebrand) |
| Success / terminal good | Delivered, RTODelivered | emerald `#10B981` |
| Attention / exception | DeliveryAttempted, OnHold, RTOInitiated, RTOInTransit | orange-red `#F43F5E` |
| Failure / terminal bad | Lost, Damaged, Cancelled, ReturnedToMerchant | deep red `#9F1239` |

Brand and "good" share emerald `#10B981` since the 2026-10-03 rebrand. They are kept apart by shape, not hue: brand appears only as filled buttons, the active-nav bar, focus rings and the row flash; "good" appears only as status dots/chips and chart series labelled Delivered. Never use a bare emerald dot or chip for anything that is not a terminal-good status.

Money uses no status colour: positive amounts in `--text-dark`/`--text-hi`, variances and negatives in `#F43F5E`.

Light and dark share the same token names (`background`, `foreground`, `card`, `primary`, `muted`, `border`, `destructive`, plus the five status tokens) so `styles.css` and `packages/mobile/constants/theme.ts` stay one vocabulary.

## Typography

- **Display / headings:** Plus Jakarta Sans (600/700). Tight tracking, used for portal titles and metric numbers.
- **Body / UI:** IBM Plex Sans (400/500). Reads well at 13–14px in dense tables, which is where this product lives.
- **Mono:** IBM Plex Mono (500) — **mandatory for AWB numbers, seal numbers, UTRs, device ids and money**. Tabular figures so columns align and a mistyped digit is visible.

Scale: 30/24/18 display · 14 body · 13 table cell · 11 uppercase label (tracking 0.08em, `--text-lo`).
Line height: 1.5 body, 1.25 headings, 1.35 table cells.

No Inter, no Space Grotesk, no Roboto.

## Layout

- **Portal shell:** fixed 232px left sidebar (`--ink-800`) with the portal name, role badge and nav; top bar carries branch scope selector, current user, sign-out. Content area scrolls independently.
- **Grid:** 8px base. Page padding 24px. Card padding 20px. Table row height 44px — dense but touchable.
- **Ops live board** is the one intentionally asymmetric screen: a wide parcel stream on the left (≈2fr) and a narrow stacked column of count tiles + exception feed on the right (1fr), not a symmetric card grid.
- **Detail is a right-hand drawer**, 480px, over a dimmed board — a dispatcher never loses the board to inspect a parcel.
- Tables: sticky header, zebra off, hover row tint, status pill in the first column after AWB, server-side pagination footer with row count.

## Components

- **StatusPill** — 11px uppercase, 999px radius, 1px border in the status colour at 40% with a 12% fill. Never a bare coloured dot; the word must be readable.
- **Timeline** — vertical rail, one node per `parcel_event`: `to_status` in status colour, then actor · role · device · timestamp in Asia/Colombo, oldest at the bottom. Append-only data gets an append-only visual: nodes never edit, a correction shows as a new node.
- **DataTable** — one component for every list across all four portals. Props: columns, pagination, filters, empty state.
- **MetricTile** — big mono number, 11px uppercase label above, optional delta. Used on every portal dashboard.
- **Drawer, Dialog, Button, Input, Select, Badge** from shadcn/ui, retinted to the tokens above. No ad-hoc CSS files.

## Motion

One staggered reveal on portal load (rows fade+rise 8px, 24ms apart, capped at ~12 rows). After that: 120ms tint on hover, 200ms drawer slide, and a brief emerald left-border flash on a table row whose status just changed on the live board. Nothing loops. Nothing pulses.

## UX rules

- Every list: loading skeleton, empty state with the reason, server-side pagination.
- Every mutating action: disabled + spinner while pending; destructive actions confirm in a dialog naming the object.
- Every action keyboard reachable; `/` focuses search on the ops board.
- **Rs. 1,250.00** money format, **DD/MM/YYYY** dates, **Asia/Colombo** rendering of UTC timestamps, week starts Monday. Never show a raw UTC string in the UI.
- An illegal state transition surfaces as a plain-language message naming the current state — never a raw 422.

## Mobile (Expo)

- Dark-first, since riders work outdoors and in basements: `--ink-900` background, emerald primary.
- **Thumb-first:** primary action is a full-width 56px button pinned to the bottom of the screen. Scan and confirm must be usable one-handed, in one tap, wearing a helmet.
- AWB in 20px mono, centred, above everything else on scan/confirm screens.
- Large touch targets (min 48px), high-contrast text, no thin weights below 14px.
- Role decides the tab set: a rider never sees transport tabs and vice-versa.
