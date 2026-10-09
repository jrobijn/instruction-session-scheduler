---
description: "Design system rules for the frontend (Range Technical). Use when creating or editing any React page, component or CSS in frontend/."
applyTo: "frontend/src/**"
---

# Frontend design system — "Range Technical"

Visual identity for a shooting association: steel/gunmetal neutrals, one blaze-orange accent, precise and dense like an instrument panel. Reference implementations: [SessionsPage.tsx](../../frontend/src/pages/SessionsPage.tsx) (list page), [SessionDetailPage.tsx](../../frontend/src/pages/SessionDetailPage.tsx) (detail page).

## Hard rules

- Build UI from primitives in `frontend/src/ui` (import from `'../ui'`). There are no global component classes; don't add any.
- No `style={{…}}` except truly dynamic values (computed widths, user-chosen group/buddy colours, CSS variables such as `--buddy`).
- No raw colours, font sizes, font families, radii or shadows outside `frontend/src/styles/tokens.css`. Use `var(--…)` tokens. Layout-only dimensions (min-width, grid templates) may be raw in a page module.
- Page-specific styling goes in a co-located `PageName.module.css`, using tokens only. Keep it small; if a pattern repeats on 2+ pages, make it a primitive (`ui/`) or shared component (`components/`).
- Icons: `lucide-react` only. No inline `<svg>` paths, no emoji or unicode glyphs as icons (`×`, `⇄`, `→`, `⋯`, `+`).
- Never put icons or symbols in i18n strings; pass them via the component's `icon` prop.
- Every user-visible string goes through `useT()` with entries in both `en.ts` and `nl.ts`.
- Icon-only buttons need an `aria-label`.
- No `window.confirm()` / `alert()`: use `useConfirm()` and `useToast()`.
- Dates follow the UI language: `getLocale() === 'nl' ? 'nl-NL' : 'en-GB'`.

## Primitives (`frontend/src/ui`)

| Need | Use |
|---|---|
| Page wrapper / title bar | `Page` (`wide` only for pages that need the full viewport; cap forms/text locally at ~40rem or use `Field split`), `PageHeader` (`title`, `back={{ label, onClick }}`, `meta` for badges, `actions` — primary last); `CenteredPage` for standalone screens (login, invitation) |
| Buttons | `Button` — `variant`: `primary` (one per view, the main action) · `secondary` (default, metal) · `ghost` (toolbar/row actions) · `danger`; `size`: `md`/`sm`; `icon={<LucideIcon />}`; `pressed` for toggles; `fullWidth` |
| Status / labels | `Badge` — `tone`: neutral/accent/success/warning/danger/info. Status tones get an icon automatically (colour is never the only signal). `mono` for counts/ratios |
| Entity tags | `Chip` (`mono`, `swatch`, `actions=[{ icon, label, onClick }]`, `onRemove`) — timeslots, assigned instructors |
| Text styling | `Text` — `tone`, `size`, `weight`, `mono` (dates, times, counts, IDs), `label` (small uppercase caption) |
| Layout | `Stack` (vertical), `Row` (horizontal) with `gap` 0–8 on the token scale, `align`, `justify`, `wrap` |
| Sections | `Card` (`title`, `actions`, `flush` when wrapping a Table) |
| Data tables | `Table` (`interactive` for clickable rows, `embedded` inside a flush Card) with plain `thead/tbody/tr/th/td`; `data-numeric` / `data-actions` / `data-shrink` cell attributes; `SortHeader` (`numeric`, `shrink`) for sortable columns; expandable rows: `ExpandIcon` + `<tr data-expanded>` / `<tr data-detail>` |
| Label/value details | `DescriptionList` (`items=[{ label, value }]`, `columns`; `inline` for one label-beside-value pair per row) |
| Row menus | `ActionMenu` (`actions=[{ label, onClick, icon?, danger? }]`); safe inside clickable rows |
| Modals | `Dialog` (`open`, `onOpenChange`, `title`, `description?`, `footer`, `size`) — primary button last in footer; forms use `<form id>` + `<Button type="submit" form="id">` |
| Confirm / errors | `useConfirm()` → `await confirm({ title, message, confirmLabel?, danger? })`; `useToast()` → `toast(message, tone?)` |
| Forms | `Field` (`label`, `htmlFor`, `hint`, `error`; `split` for settings rows: label/hint left, control right, stacks when narrow, consecutive rows get dividers; `split="wide"` when the control is large, e.g. `RadioCards`) wrapping `Input`, `Select`, `Textarea`, `DateInput`, `ColorInput`; `Checkbox` (`label`, `description`, `card`); `RadioCards`; `Slider` |
| Messages | `Alert` (`tone`, `title?`, `action?`) |
| Empty lists | `EmptyState` (`icon`, `title`, `description`, `action?`) |
| Floating panels | `Popover` (`trigger`, `flush`, `align`); `Tooltip` (`content`) — replaces `title=` on interactive hints |
| Tabs | `Tabs`, `TabList`, `Tab`, `TabPanel` (Radix) |

Shared app components (`frontend/src/components`): `CsvActions` + `ImportResultAlert`, `SessionStatusBadge` / `InvitationStatusBadge` / `GroupLabel` (`StatusBadges.tsx`), `AllocationBar`, `StudentSearchResults`, `NotificationItem`, `DecisionLog`, `Logo`, and `BuddyRows.module.css` for buddy-group rows.

Missing something? Add a new primitive in `ui/` (Radix primitive from `radix-ui` if it involves focus, overlay or keyboard behaviour) with its own `.module.css`, export it from `ui/index.ts`, and add it to this table.

## Visual language

- **Colour**: neutrals carry the UI. Orange `--color-accent` is reserved for the primary action, the active/selected marker (3px bar) and focus rings — never for large backgrounds or decoration. Use `--color-accent-text` when orange is text/icon on a surface.
- **Status colours**: success = olive, warning = ochre, danger = deep red, info = steel blue. Always pair with an icon or text.
- **Metal**: `--metal-sheen` / `--accent-sheen` gradients only on the nav bar and buttons. No other gradients, no glassmorphism, no glow.
- **Type**: Barlow body; Barlow Semi Condensed uppercase for headings, labels, table headers, nav and tabs; IBM Plex Mono for dates, times, counts and ratios.
- **Shape**: 2–3px radii (`--radius-sm/md`), hairline borders, shadows only on floating layers (menus, dialogs, tooltips). No pill-shaped buttons, no rounded-2xl cards, no drop shadows on cards.
- **Density**: compact. Use the spacing scale (`--space-*`, 4px grid); prefer `Stack`/`Row` gaps over margins.
- **Motion**: short (`--duration-fast/normal`), opacity/translate only; respect `prefers-reduced-motion`.
- Both themes must work: check every change in light (brushed aluminium) and dark (gunmetal).

## Third-party styling

Global overrides for third-party widgets live in `frontend/src/styles/` (e.g. `datepicker.css` for react-datepicker), tokens only.
