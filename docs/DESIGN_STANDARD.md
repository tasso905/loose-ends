# Loose Ends — Visual Design Standard

Oct 18, 2026 · @Tasso Z

Loose Ends should look like a well-kept paper ledger: warm paper, dark ink, one blue for actions, and receipts you can see. Every value below is the default to apply exactly; to deviate, change this document first.

## How to use this standard

This standard covers every page in site contract v1.1 (Sign in, Today, Add, Review Tray, Threads, Thread detail, Why panel, Source viewer, Resolve, Decisions / Ask Why, Settings). It assumes Tailwind + shadcn/ui + Lucide, as the PRD specifies. Light theme ships in the MVP; dark tokens are defined so the theme is ready, but dark mode is a NICE-to-have and is not built during Build Fest.

Five rules settle most visual questions:

- **Calm over alert.** Colour marks state only when the state matters. Nothing pulses, counts in red, or moves to get attention.
- **Provenance is visible.** Source facts, the user's own words, and AI interpretation each have their own font, rule and label (see Three voices).
- **Never colour alone.** Every state pairs colour with a word and an icon or shape.
- **One of each.** One sans family, one serif reserved for evidence, one accent colour, one elevation for floating layers.
- **Tokens, not values.** Components reference the CSS custom properties in the Tokens section. No raw hex or pixel values in component code.

When this document and a component library default disagree, this document wins.

## Colour palette

The palette is warm neutrals with one ink-blue accent; green, amber and muted red appear only as small state markers, never as large fills. Roughly 90% of any screen is paper and ink.

### Backgrounds and surfaces

| Token | Hex | Use |
| --- | --- | --- |
| `--bg` | #F7F5F0 | Page canvas behind everything. Warm paper; carries the grain texture. |
| `--surface` | #FFFEFB | Cards, thread lists, Explain card, form panels. The "sheet of paper" on the desk. |
| `--surface-hover` | #F6F3EC | Hover fill for rows and cards that sit on `--surface`. |
| `--surface-sunken` | #F1EEE7 | Inputs, textareas, evidence blocks, source viewer, secondary button hover. |
| `--surface-raised` | #FFFFFF | Menus, popovers, toasts, dialogs, the Why sheet. Always paired with a shadow. |
| `--border` | #E4DFD5 | Card outlines, row dividers, input borders at rest. 1px only. |
| `--border-strong` | #CFC8BA | Input hover border, "You wrote" and Interpretation rules, checkbox outlines. |
| `--scrim` | rgba(22, 21, 19, 0.32) | Overlay behind dialogs and sheets. |

### Text

| Token | Hex | Use | Contrast on `--bg` |
| --- | --- | --- | --- |
| `--text` | #1F1D1A | Headings, body, thread titles, source quotes. | \~16:1 |
| `--text-secondary` | #5C574F | Reason lines, metadata, Interpretation text, helper text. | \~6.6:1 |
| `--text-tertiary` | #736D63 | Timestamps, captions, placeholder text, disabled labels. The lightest text allowed. | \~4.7:1 |
| `--text-on-accent` | #FFFFFF | Text and icons on primary buttons. | \~8.6:1 on accent |

No text lighter than `--text-tertiary`, at any size.

### Accent (actions only)

| Token | Hex | Use |
| --- | --- | --- |
| `--accent` | #2E4A86 | Primary buttons, links, active nav item, selected filter indicator, focus ring. |
| `--accent-hover` | #253D70 | Primary button hover; link hover. |
| `--accent-pressed` | #1D3260 | Primary button pressed. |
| `--accent-subtle` | #E8EDF6 | Selected row background, active nav pill, checked checkbox container on cards. |

The accent means "you can act here". Never use it for decoration, headings, status or AI output.

### State colours

Each state has a foreground (`-fg`, for text and icons, all ≥ 4.5:1 on its own `-bg`), a background (`-bg`, for chips only) and a dot (`-dot`, the 8px marker).

| State | `-fg` | `-bg` | `-dot` | Where it appears |
| --- | --- | --- | --- | --- |
| Likely (High confidence) | #2F6140 | #E7F1E9 | #3F7A4E (filled) | Review Tray group label and card label. |
| Maybe (Medium) | #8A5A12 | #FBF1DD | #B7791F (filled) | Review Tray group label and card label. |
| Also noticed (Low) | #5C574F | #F1EEE7 | #9A9387 (hollow ring) | Collapsed Review Tray group. Never in Today. |
| Due today / due soon | #8A5A12 | #FBF1DD | none, clock icon | Due chip. |
| Overdue | #A23B32 | #F8E6E3 | none, clock icon | Due chip only. Never a row fill, badge or count. |
| Resolved | #2F6140 | #E7F1E9 | none, check icon | Status chip and Recently resolved list. |
| Open, Waiting, Snoozed, Dismissed | `--text-secondary` | `--surface-sunken` | none, icon per status | Status chip. Lifecycle states are neutral; only time and confidence get colour. |
| Error (forms, failed extraction) | #A23B32 | #F8E6E3 | none, alert icon | Inline error text and error banner. |

Amber is shared by Maybe and due-soon on purpose: both mean "look a little closer". They never look alike because confidence uses a dot + word and dates use a clock icon + date.

### Evidence and provenance

| Token | Hex | Use |
| --- | --- | --- |
| `--evidence-rule` | #B9AE98 | 2px left rule on source quotes. The product's signature mark. |
| `--evidence-bg` | #F1EEE7 | Fill behind source quotes (same as `--surface-sunken`). |
| `--highlight` | #F7E6A6 | Marker highlight on the quoted span in the source viewer and Why panel context. |

### Dark tokens (defined, not shipped in MVP)

| Token | Dark hex |
| --- | --- |
| `--bg` / `--surface` / `--surface-sunken` / `--surface-raised` | #161513 / #1E1C19 / #121110 / #26231F |
| `--border` / `--border-strong` | #34302A / #4A453C |
| `--text` / `--text-secondary` / `--text-tertiary` | #ECE8E1 / #B3ACA0 / #8F887C |
| `--accent` / `--text-on-accent` | #9DB3E0 / #10151F |
| Likely / Maybe / Overdue `-fg` | #8FC69D / #E6B465 / #E8958B |
| `--evidence-rule` / `--highlight` | #8C8170 / #4A3F1E |

## Typography

One sans family does all the work; one serif appears only when the app is quoting a source. The scale is deliberately flat (about 1.2× per step) so nothing shouts.

### Families

| Role | Family | Fallback stack | Where |
| --- | --- | --- | --- |
| UI and body | IBM Plex Sans | system-ui, -apple-system, "Segoe UI", sans-serif | Everything that is not a source quote. |
| Evidence | IBM Plex Serif | Georgia, "Times New Roman", serif | Verbatim source quotes only: Review Tray evidence, Why panel, Explain card source lines, "From the source" in Ask Why. |
| Data | IBM Plex Mono | ui-monospace, SFMono-Regular, Menlo, monospace | Export filenames, IDs in Settings → Data. Nowhere else. |

All three are OFL-licensed and self-hosted via `next/font` (no runtime request to a font CDN). Load only the weights listed below.

### Weights

| Weight | Name | Use |
| --- | --- | --- |
| 400 | Regular | Body, reason lines, quotes, inputs, helper text. |
| 500 | Medium | Thread titles in lists, buttons, nav labels, chip labels, form labels, table headers. |
| 600 | Semibold | Page titles (H1), section headings (H2, H3), eyebrow labels. |

No 300 and no 700. No italic anywhere: emphasis uses weight 500, and quotes are set apart by the serif and the rule, not by slant.

### Type scale

| Style | Size / line height | Weight | Letter spacing | Use |
| --- | --- | --- | --- | --- |
| `display` | 28 / 36px | 600 | -0.01em | Page title: "Today", "Add", "Threads", thread title on Thread detail. One per page. |
| `h2` | 20 / 28px | 600 | -0.005em | Section headings: "Worth your attention", "I found 3 things in this", Explain card title. |
| `h3` | 17 / 24px | 600 | 0 | Card and group headings: "Likely", "Maybe", "Waiting on others", dialog titles. |
| `body` | 16 / 26px | 400 | 0 | Default text, Explain card lines, Ask Why answers, empty states. |
| `body-strong` | 16 / 24px | 500 | 0 | Thread and proposal titles in lists, button labels at default size. |
| `quote` | 16 / 26px, Plex Serif | 400 | 0 | Verbatim source excerpts. |
| `small` | 14 / 20px | 400 | 0 | Reason lines, metadata, timestamps, helper and error text, small button labels. |
| `label` | 13 / 16px | 500 | +0.01em | Chips (confidence, due, status), "Interpretation", "You wrote", "Suggested" tags. |
| `eyebrow` | 12 / 16px | 600 | +0.06em, uppercase | Explain card section labels (WHAT THIS IS, BY WHEN, NOT SURE ABOUT) and settings group labels. The only uppercase text. |

Below 640px, `display` becomes 24 / 32px and `h2` becomes 18 / 26px. Everything else is unchanged; `body` never drops below 16px, and inputs stay at 16px so iOS does not zoom on focus.

### Rhythm and measure

- Space between a heading and the text it introduces is always smaller than the space above the heading (see Spacing).
- Prose blocks cap at 68ch. The 720px content column already keeps most lines near 70 characters.
- Paragraph spacing is 12px; never indent paragraphs.
- Dates, amounts, counts and times use `font-variant-numeric: tabular-nums` so they align in lists, like a statement.
- Truncate thread titles at one line in lists with an ellipsis; show the full title on Thread detail and in the accessible name.
- Curly quotation marks (“ ”) around quoted user and source text; never straight quotes in UI copy.

## Spacing

The base unit is 4px and every gap is a step on one scale. The philosophy is "tight within, generous between": things that belong together sit close, and groups are separated by clearly more air, so the eye reads structure before it reads words.

### Scale

| Token | px | Tailwind | Typical use |
| --- | --- | --- | --- |
| `space-1` | 4 | 1 | Icon to its own chip text; dot to label. |
| `space-2` | 8 | 2 | Icon to button label; title to reason line; between chips. |
| `space-3` | 12 | 3 | Paragraph spacing; label to input; evidence block above/below its title. |
| `space-4` | 16 | 4 | Default padding inside rows and input groups; gap between buttons; mobile page gutter. |
| `space-5` | 20 | 5 | Card padding (desktop); between form fields. |
| `space-6` | 24 | 6 | Page title to first content; dialog and sheet padding; tablet gutter. |
| `space-8` | 32 | 8 | Between groups inside a page (Likely → Maybe); desktop gutter; page top padding. |
| `space-12` | 48 | 12 | Between major page sections (Worth your attention → Waiting on others). |
| `space-16` | 64 | 16 | Bottom padding of every page, so the last item never sits on the viewport edge. |

No other values. If something needs 10px or 14px, use 8 or 12.

### Relationship rules

1. Related items inside one object (title, reason, chips of a thread row): 4–8px.
2. Siblings in a list or form (rows, fields, proposal cards): 12–20px, or 0 with a 1px divider for ledger-style lists.
3. Groups within a page (Review Tray groups, Explain card sections): 32px.
4. Major sections of a page: 48px (40px below 640px).
5. A heading always sits closer to what follows it than to what precedes it: 32–48px above, 8–12px below.

### Layout

| Element | Value |
| --- | --- |
| Content column | max-width 720px, centred. Review Tray with source side-by-side: 1120px at ≥ 1024px only. |
| Page gutter | 16px below 640px · 24px 640–1023px · 32px at ≥ 1024px |
| Page padding | top 32px desktop / 24px mobile; bottom 64px (plus bottom nav height on mobile) |
| Top bar | 56px tall, from 768px up. Wordmark left; Today · Threads · Decisions after it; Add (primary, small) and the account menu right. |
| Mobile bottom nav | 64px + `env(safe-area-inset-bottom)`, below 768px. Four items: Today, Threads, Add (centre), Decisions; icon (20px) over label (12/16px, 500). Paired with a 48px mobile header: wordmark left, account button right. |
| Why sheet | 440px wide side sheet on desktop; full-width bottom sheet below 768px, max-height 85vh. |
| Dialog | max-width 480px. |
| Breakpoints | `sm` 640px · `md` 768px · `lg` 1024px. Nothing is designed for widths above 1280px; the column simply centres. |

### Component padding and sizes

| Component | Padding / size |
| --- | --- |
| Card | 20px (16px below 640px); radius 10px; 1px `--border` |
| Thread row (in a card) | 16px vertical, 20px horizontal; rows divided by 1px `--border`; no gap between rows |
| Review Tray proposal card | 20px; 12px between cards in a group |
| Button, default | height 40px, 16px horizontal, 8px icon gap, radius 6px |
| Button, small | height 32px, 12px horizontal, radius 6px |
| Icon button | 40 × 40px, 20px icon |
| Touch targets below 768px | every interactive element ≥ 44 × 44px; default buttons grow to 44px tall |
| Text input | height 44px, 12px horizontal, radius 6px |
| Paste textarea | 16px padding, min-height 240px, resizes vertically only |
| Chip | height 24px, 8px horizontal, 4px between dot/icon and text, radius 6px |
| Confidence dot | 8px circle |
| Evidence block | 12px vertical, 16px horizontal; 2px left rule; radius 0 6px 6px 0 |
| Dialog and sheet | 24px padding; 24px between body and action row |
| Toast | 12px vertical, 16px horizontal; 24px from viewport bottom (above bottom nav on mobile); max-width 420px |

Radii are 6px for controls and chips, 10px for cards, 14px for dialogs and sheets, and 50% for dots and avatars. No pill-shaped buttons.

## Texture and atmosphere

The world is paper on a desk: a faintly grained canvas, clean white sheets with hairline edges, and quotes set off like clipped receipts. Depth comes from borders, not shadows; only things that float above the page cast one.

### Grain

- One grain layer, on `--bg` only. Cards, inputs and floating layers are clean.
- Implementation: a fixed, full-viewport `::before` on `body` with an inline SVG `feTurbulence` tile (`type="fractalNoise"`, `baseFrequency="0.8"`, `numOctaves="2"`), 160px tile, `opacity: 0.03` in light and `0.04` in dark, `pointer-events: none`, `z-index: 0`.
- The grain must be invisible in a screenshot at 50% zoom. If someone notices it, it is too strong.
- Off in print and under `forced-colors: active`.

### Elevation

| Level | Treatment | Used by |
| --- | --- | --- |
| 0, page | `--bg` + grain | Canvas |
| 1, sheet | `--surface`, 1px `--border`, no shadow | Cards, thread lists, Explain card, forms |
| 2, floating | `--surface-raised`, 1px `--border`, `0 1px 2px rgba(31,29,26,0.06), 0 8px 24px rgba(31,29,26,0.08)` | Menus, popovers, tooltips, toasts |
| 3, modal | `--surface-raised`, no border, `0 16px 48px rgba(31,29,26,0.16)` over `--scrim` | Dialogs, Why sheet, Resolve sheet |

Cards never gain a shadow on hover. Nothing uses an inner shadow.

### Gradients

None on surfaces, buttons or headers. The single permitted gradient is a 32px fade mask (`linear-gradient(to bottom, transparent, var(--surface))`) at the end of truncated quote context in the Why panel, to signal "more above/below".

### Blur

- The sticky top bar and the mobile bottom nav use `--bg` at 92% opacity with `backdrop-filter: blur(8px)`. Fallback without support: solid `--bg`.
- Scrims behind dialogs and sheets are not blurred, so the user can still see where they came from.
- No other blur.

### Signature details

- **The evidence rule.** A 2px `--evidence-rule` line on the left of every verbatim source quote, on an `--evidence-bg` fill, set in Plex Serif. It is the one visual idea the product is built around; do not reuse it for anything that is not a verified quote.
- **Ledger lists.** Lists of threads are one card divided by hairlines, not floating tiles.
- **Tabular dates.** Due dates and amounts align right in rows, in tabular figures.
- **Icons.** Lucide, `strokeWidth={1.75}`, 16px inline with `small` text, 20px in buttons and nav, coloured with the text they sit beside. No filled icons except the confidence dot.
- **No imagery.** No illustrations, mascots, stock photos, emoji or decorative patterns, including in empty states.

## Interactions

Movement should feel like a card being set down on a desk: it settles, it never arrives. Motion confirms what the user just did; it never urges them to do something.

### Timing

| Token | Duration | Use |
| --- | --- | --- |
| `--dur-instant` | 0ms | Focus rings, text changes, checkbox focus. Focus never animates. |
| `--dur-press` | 60ms | Pressed state colour. |
| `--dur-fast` | 120ms | Hover colour and underline, checkbox tick, chip state change. |
| `--dur-base` | 180ms | Menus, popovers, tooltips, toasts entering, status text crossfades. |
| `--dur-slow` | 240ms | Sheets and dialogs entering, accordion expand (Waiting on others, Also noticed), cards collapsing after accept. |

Exits run at 0.75× their entrance (sheets leave in 180ms). Nothing runs longer than 240ms except the loading indicators below. This sits inside the site contract's 150–200ms range for small changes and stays under it for hover.

### Easing

| Token | Curve | Use |
| --- | --- | --- |
| `--ease-out` | cubic-bezier(0.2, 0, 0, 1) | All entrances and state changes. Fast start, long soft landing. |
| `--ease-in` | cubic-bezier(0.4, 0, 1, 1) | Exits only. |
| `linear` | linear | Spinner rotation only. |

No springs, bounce, overshoot or elastic curves.

### Hover, focus, pressed, disabled

| Element | Hover | Pressed | Focus-visible |
| --- | --- | --- | --- |
| Primary button | bg `--accent` → `--accent-hover` | `--accent-pressed` | 2px `--accent` ring, 2px offset in `--bg` |
| Secondary button (1px `--border-strong`, `--surface` fill) | fill `--surface-sunken` | fill `--border` | same ring |
| Ghost button (row quick actions: Done, Snooze, Why?) | fill `--surface-sunken`, text `--text` | fill `--border` | same ring |
| Thread row / proposal card | fill `--surface-hover`; title gets no underline | fill `--surface-sunken` | ring inset 2px inside the row |
| Link (in text and "Open source") | underline fades in: 1px, offset 3px, colour `--accent-hover` | none | same ring, 2px radius |
| Nav item | text `--text`, fill `--surface-sunken` | none | same ring; active item keeps `--accent-subtle` fill and `--accent` text |
| Filter tab (Active / Closed) | text `--text` | none | same ring; selected = 2px `--accent` bottom border + weight 500 |
| Input / textarea | border `--border-strong` | n/a | border `--accent` + 3px `--accent-subtle` outer ring |
| Destructive button (Forget permanently, inside confirmation only) | bg #8A3129 from #A23B32 | #722820 | same ring |

Rules that apply to all of them:

- Hover changes colour only. No movement, scaling, lifting or shadow.
- Every hover affordance is also reachable by keyboard; tooltips appear on focus as well as hover, after a 400ms delay, and never hold the only copy of an instruction.
- Disabled: 50% opacity, `cursor: not-allowed`, no hover change. The reason it is disabled is written next to it (for example the 30,000-character limit with the current count).
- Hover styles are wrapped in `@media (hover: hover)` so touch devices never show sticky hover states.

### Product moments

| Moment | Behaviour |
| --- | --- |
| Extraction in progress | Skeleton proposal cards pulse opacity 1 → 0.6 → 1 over 1.6s, `ease-in-out`. Above them, the real pipeline step ("Reading…", "Finding commitments…", "Checking dates…") crossfades at `--dur-base` when the server reports a new step. No percentages, no fake timers. |
| Saving / submitting | Button label stays; a 16px Lucide `Loader2` replaces the icon and rotates 900ms linear; button is disabled to prevent double submits. |
| Accept selected | Accepted cards collapse (height + opacity, `--dur-slow`), then one line appears in their place: "2 threads added · View in Today". |
| Reject | Card drops to 50% opacity with an inline "Rejected · Undo"; it does not disappear until the tray is left. |
| Done / Resolve from a row | Checkmark draws in (stroke-dashoffset, `--dur-slow`), the row holds for 600ms, then collapses; an Undo toast appears. |
| Undo toast | Enters 8px up + fade, `--dur-base`; stays 8s; the timer pauses while hovered or focused, but the toast always closes 11s after the action, 1s before the server stops accepting the undo at 12s (D44, D49, D51). No countdown bar. |
| Open evidence | Source viewer scrolls the quoted span into view (`smooth`, centred); `--highlight` appears at full strength and settles to 60% over 600ms, then stays while the panel is open. |
| Overdue, due today | Never animated. A thread becoming overdue changes its chip colour on next render and nothing else. |

Forbidden everywhere: confetti, celebratory bursts, pulsing badges, shaking error fields, page-slide transitions between routes, parallax and auto-advancing content.

### Reduced motion

Under `prefers-reduced-motion: reduce`: all transforms and height animations are removed; opacity fades drop to 0–120ms; the skeleton pulse stops and holds at 0.8 opacity; smooth scrolling becomes instant; the spinner keeps rotating because it carries status, but every spinner also has visible status text.

## Three voices

Every line of AI-touched text is in exactly one of three voices, and the voice is visible from font, rule and label together.

| Voice | Font | Left rule | Label (`label` style, above or before the text) | Text colour |
| --- | --- | --- | --- | --- |
| Source fact | Plex Serif `quote` | 2px solid `--evidence-rule`, `--evidence-bg` fill | Quote icon + source name and page/date: "Renewal notice · p. 2" | `--text` |
| You wrote | Plex Sans `body` | 2px solid `--border-strong`, no fill | "You wrote · Oct 18" | `--text` |
| Interpretation / AI suggestion | Plex Sans `body` | 2px dashed `--border-strong`, no fill | "Interpretation" or "Suggested" | `--text-secondary` |

An interpretation never shares a sentence or a block with a quote. A user-edited field drops its "Suggested" label and is shown as the user's.

## Component recipes

**Thread row (Today, Threads).** One row = 8px confidence or status marker · title (`body-strong`, one line) · due chip right-aligned. Second line, 4px below: reason line in `small` `--text-secondary`, ending with a "Why?" link; quick actions (Done, Snooze) as ghost small buttons, visible at rest on touch and on hover/focus-within on desktop. Maximum two chips per row.

**Confidence label.** Dot + word + reason: "● Likely · Clear commitment with a date". Word in `label` style using the state `-fg`; reason in `small` `--text-secondary`. Low uses a hollow ring dot.

**Due chip.** Clock icon (14px) + date in tabular figures: "Due tomorrow", "Fri Oct 9", "3 days overdue". Inferred dates add an "Assumed" chip with a dotted 1px `--border-strong` outline and a tooltip explaining the resolution.

**Explain card.** `--surface` card; `h2` title; sections separated by 24px, each headed with an `eyebrow` label in `--text-tertiary`. "Not sure about" uses the Maybe `-bg` fill behind its list so uncertainty is never missed. Quick-add threads show only What to do and By when.

**Empty states.** Centred in the column, 64px from the section top: one `h3` sentence ("Nothing needs you right now."), one `small` line, one secondary button. No icon larger than 20px.

**Confirmation dialogs (Forget permanently, Delete source).** `h3` title naming the action; a plain list of exactly what will be deleted; Cancel (secondary, left) and the destructive button (right) with the full action name, never "OK".

## Iconography map

Every icon below is a Lucide icon at `strokeWidth={1.75}`. Use exactly these; do not substitute look-alikes.

| Meaning | Lucide icon | Where |
| --- | --- | --- |
| Today | `Sun` | Nav |
| Threads | `Layers` | Nav |
| Decisions | `Scale` | Nav |
| Add | `Plus` | Nav, global Add button |
| Paste / Upload / Quick add | `ClipboardPaste` / `FileUp` / `TextCursorInput` | Add tabs |
| Status: Open | `Circle` | Status chip, Threads rows |
| Status: Waiting / Mark waiting | `Hourglass` | Status chip, action |
| Status: Snoozed / Snooze | `Moon` | Status chip, action |
| Status: Resolved / Done | `CircleCheck` (status), `Check` (action) | Chip, quick action |
| Status: Dismissed / Dismiss | `CircleSlash` | Chip, action |
| Due, due soon, overdue | `Clock` | Due chip (colour carries urgency, the date carries the meaning) |
| Source quote | `Quote` | Evidence label |
| You wrote | `PenLine` | Voice label |
| Suggested | `Sparkle` (single, 14px) | Suggested tag |
| Why? | `CircleHelp` | Why link |
| Open source | `FileText` | Link |
| Edit / Reopen / Undo | `Pencil` / `RotateCcw` / `Undo2` | Actions, toast |
| More actions | `Ellipsis` | Overflow trigger |
| Forget permanently / Delete | `Trash2` | Destructive actions only |
| Error / Info | `CircleAlert` / `Info` | Banners, field errors |
| Settings / Export / Sign out | `Settings` / `Download` / `LogOut` | Account menu |
| Demo date | `Clock` | Demo banner |
| Loading | `Loader2` | Buttons, inline loading |

Interpretation and Assumed have no icon: Interpretation is marked by its label and dashed rule; Assumed by its dotted chip outline.

## More component recipes

**Why sheet.** Level-3 modal, 440px side sheet (bottom sheet below 768px). `h3` title "Why am I seeing this?". Order: source quote block (context text in `--text-secondary`, the quote itself in `--text` with `--highlight` behind it, 32px fade masks top and bottom) → source line in `small` → reasoning steps as plain `body` sentences, 8px apart → "Why now" line in `body-strong` → corrections in the You wrote voice → action row: "This is wrong" (secondary) and "Open source" (link). Deleted source: replace "Open source" with a `small` `--text-tertiary` line "Original source deleted on Oct 12."

**Resolve sheet.** Level-3 modal, 480px dialog on desktop, bottom sheet on mobile. `h3` "How did this end?" then three radio cards in a row (stacked below 640px), each 1px `--border`, 16px padding, selected = 2px `--accent` border + `--accent-subtle` fill. When Decided is selected, the decision input and "Want me to remember why?" textarea (min-height 96px, autofocus) expand below at `--dur-slow`. Action row: Skip (secondary) and Save (primary), equal width.

**Ask Why answer card.** `--surface` card. Parts in fixed order, each a block 16px apart: "You decided · Oct 18, 2026" (`label`, then the choice in `body-strong`) → You wrote voice → Source fact voice → Interpretation voice. Footer: "Open thread" link. No-match state: the same card with one `body` sentence and no voices.

**Source viewer.** Content column at 720px; header block with `display` title and `small` metadata line. Body in Plex Sans `body` (not serif: the serif marks extracted quotes, not whole documents). PDF page markers: `eyebrow` "PAGE 2" with a 1px `--border` rule above, 32px top margin. Highlighted span uses `--highlight` with 2px horizontal padding and `box-decoration-break: clone`.

**File drop zone.** 1.5px dashed `--border-strong`, radius 10px, min-height 160px, `--surface-sunken` fill, centred `FileUp` icon (20px) + `body` "Drop a file or choose one" + `small` "PDF, TXT, MD or DOCX · up to 10 MB and 30 pages". Drag-over: border becomes solid 2px `--accent`, fill `--accent-subtle`. File chosen: a row with file name, size and a remove button replaces the prompt. Error: border `--danger-fg`, message below in the error style.

**Error banner.** Full content-column width, `--danger-bg` fill, 1px `--danger-fg` at 30% opacity border, radius 10px, 12px 16px padding, `CircleAlert` + message in `body` `--text` + action button (secondary small) right-aligned. Never dismissible while the problem remains. Field errors: `small` in `--danger-fg` with `CircleAlert` 14px, 4px below the field, linked by `aria-describedby`; the field border turns `--danger-fg`.

**Info notice.** Same shape as the error banner with `--surface-sunken` fill, `--border` outline and `Info` icon. Used for onboarding notes and the scan limitation.

**Checkbox.** 18px box, radius 4px, 1.5px `--border-strong`; checked = `--accent` fill with white `Check` (14px, stroke 2.5); hit area 40px (44px on mobile). Used in the Review Tray only.

**Toggle.** 36 × 20px track, 16px thumb; off track `--border-strong`, on track `--accent`; thumb `--surface-raised` with the floating shadow; label to the left, description below in `small` `--text-secondary`. Used in Settings only.

**Snooze menu and date picker.** Menu (level 2) with three items: "Tomorrow, 9:00", "Next Monday, 9:00", "Pick a date…", each with the resolved date right-aligned in `small` `--text-tertiary` tabular figures. "Pick a date…" opens a shadcn Calendar in the same popover; past dates disabled; today outlined with 1px `--border-strong`; selected = `--accent` fill.

**Overflow menu.** `Ellipsis` icon button labelled "More actions"; level-2 menu, min-width 200px, items 36px tall (44px on mobile), 12px horizontal padding, icon 16px + `body` label. Destructive items sit last, after a 1px divider, in `--danger-fg`.

**Tooltip.** Level 2, `--text` background with `--bg` text (inverted), `small`, 6px 8px padding, radius 6px, max-width 280px, 400ms show delay, no arrow.

**Skeleton.** Blocks in `--surface-sunken`, radius 6px; text lines 12px tall at 100%, 80% and 60% widths; rows keep the real row height so nothing jumps when content arrives.

**Undo toast.** Level 2, `--text` background, `--bg` text (inverted), `small` message + "Undo" text button in `--accent-subtle` colour, radius 10px. One toast at a time; a new one replaces the old.

**Review chip.** Chip style in `--accent-subtle` with `--accent` text: "3 to review". Sits at the right end of the Today greeting line; it is a link.

**Clarification prompt.** Info notice shape above the Review Tray groups: `body-strong` question, then participant names as secondary buttons in a wrapping row plus "None of them". After a choice, the notice becomes "Remember 'Sam' as you?" with Yes / No small buttons.

**Demo-date banner.** Full-width, 32px, `--accent-subtle` fill, `label` text in `--accent` centred: `Clock` + "Demo date: Thu Oct 8, 2026". Sits above the top bar or mobile header, not sticky, never dismissible. `DEMO_MODE` only.

**Wordmark and favicon.** Wordmark: "Loose Ends" in Plex Sans 600, 17px, -0.01em, `--text`, preceded by the mark at 20px with 8px gap. Mark: two 2px-stroke horizontal lines on one baseline with a 4px gap and rounded caps (a line left unfinished), drawn in `--text`. Favicon: the mark centred on a `--bg` square with 6px radius, as SVG (with a dark-scheme media query) plus 32px and 180px PNGs. No other logo treatments.

## Dates and numbers

All dates render in the user's timezone from `getNow()`, formatted with `Intl.DateTimeFormat` in `en-US` for the MVP.

| Situation | Format | Example |
| --- | --- | --- |
| Due today / tomorrow | Relative word | "Due today", "Due tomorrow" |
| Due in 2–6 days | Short weekday | "Due Fri" |
| Due 7+ days ahead, same year | Weekday, month, day | "Fri Oct 30" |
| Different year | Add the year | "Fri Jan 8, 2027" |
| Overdue | Count of days | "1 day overdue", "3 days overdue" |
| History timestamps | Month, day, time | "Oct 18, 9:42 AM" |
| Greeting | Full weekday and date | "Sunday, October 18" |
| Decision date | Month, day, year | "Oct 18, 2026" |

Time appears only when the source or the user gave one; date-only deadlines never show "11:59 PM". Amounts are shown exactly as written in the source (`amount_text`), never reformatted or converted. Counts are numerals. No relative phrasing beyond seven days, and never seconds.

## shadcn/ui mapping

shadcn components read their own variable names, and its `--accent` means "hover fill", which clashes with this standard's accent. To avoid the clash, every token in this standard is emitted in code with an `le-` prefix (`--le-accent`), and shadcn's variables are set from them in `globals.css` (see Tokens).

| shadcn variable | Set from |
| --- | --- |
| `--background` / `--foreground` | `--le-bg` / `--le-text` |
| `--card` / `--card-foreground` | `--le-surface` / `--le-text` |
| `--popover` / `--popover-foreground` | `--le-surface-raised` / `--le-text` |
| `--primary` / `--primary-foreground` | `--le-accent` / `--le-text-on-accent` |
| `--secondary` / `--secondary-foreground` | `--le-surface-sunken` / `--le-text` |
| `--muted` / `--muted-foreground` | `--le-surface-sunken` / `--le-text-secondary` |
| `--accent` / `--accent-foreground` | `--le-surface-hover` / `--le-text` |
| `--destructive` | `--le-danger-fg` |
| `--border` / `--input` / `--ring` | `--le-border` / `--le-border` / `--le-accent` |
| `--radius` | 10px (card); controls override to 6px |

## Contrast verification

The ratios in this document are calculated estimates. Before day 21 they are verified, not trusted:

- `@axe-core/playwright` runs on Today, Review Tray, Thread detail, Why sheet, Decisions and Settings in CI; any contrast violation fails the build.
- These pairs are checked by hand once with a contrast tool: each state `-fg` on its `-bg`; `--text-tertiary` on `--bg`, `--surface` and `--surface-sunken`; `--accent` on `--accent-subtle`; inverted toast and tooltip text.
- If a pair fails, darken the foreground in steps of about 5% lightness until it passes; never lighten the background.
- Focus rings and component boundaries meet 3:1 against adjacent colours.

## Microcopy

The interface speaks like a careful assistant handing over a ledger: plain, specific, unhurried.

- **Person.** The system says "I" when explaining its own reading ("I read 'Friday' as Fri Oct 9"); the user is "you". Never "we" for the system.
- **Case and punctuation.** Sentence case everywhere, including buttons and headings. No exclamation marks. Ellipsis (…) only on actions that open a further step ("Resolve…", "Pick a date…", "Forget permanently…").
- **Buttons.** Verb first, naming the result: "Accept selected", "Email me a sign-in link". Never "OK", "Submit" or "Yes" alone.
- **Counts.** Only small and true: "2 things are worth your attention". Never "You have 17 reminders", never a count in red.
- **No guilt.** Never "You still haven't…", "Don't forget!" or "Overdue!"; state the fact ("3 days overdue").
- **Source words first.** Reason lines reuse the source's own phrase in quotes: "You told Mike 'Friday'".
- **Errors.** What happened, then what to do, in two short sentences; never "Oops" or blame. Exact strings live in site contract §2.13.
- **Uncertainty.** Say what is uncertain and why: "I'm not sure who said this", not "Low confidence".
- **Terms.** Use the content model glossary: Done, Resolve…, Not needed, Dismiss, Forget permanently, Assumed, Interpretation, Suggested, You wrote.

## Decision rules

When something is not covered above, apply these in order:

1. Can it be done with paper, ink and a hairline? Then do that before adding colour, shadow or motion.
2. Is the colour signalling a state the user must act on? If not, use a neutral.
3. Is the accent on something clickable? If not, remove it.
4. Does the state still read in greyscale? If not, add a word or icon.
5. Is the value on the scale (4px spacing, type scale, durations)? If not, round to the nearest token.
6. Would the change make an unfinished item feel punitive or urgent? Then don't make it.

## Tokens

Copy into `app/globals.css`. In code every token carries the `le-` prefix (this document drops it for readability), and shadcn's own variables are set from them as in the shadcn/ui mapping. Tailwind reads the same variables via `theme.extend` (`colors.le.accent: 'var(--le-accent)'`, and so on).

```css
:root {
  /* Loose Ends tokens */
  --le-bg: #F7F5F0; --le-surface: #FFFEFB; --le-surface-hover: #F6F3EC;
  --le-surface-sunken: #F1EEE7; --le-surface-raised: #FFFFFF;
  --le-border: #E4DFD5; --le-border-strong: #CFC8BA; --le-scrim: rgba(22,21,19,.32);
  --le-text: #1F1D1A; --le-text-secondary: #5C574F; --le-text-tertiary: #736D63; --le-text-on-accent: #FFFFFF;
  --le-accent: #2E4A86; --le-accent-hover: #253D70; --le-accent-pressed: #1D3260; --le-accent-subtle: #E8EDF6;
  --le-likely-fg: #2F6140; --le-likely-bg: #E7F1E9; --le-likely-dot: #3F7A4E;
  --le-maybe-fg: #8A5A12; --le-maybe-bg: #FBF1DD; --le-maybe-dot: #B7791F;
  --le-low-dot: #9A9387;
  --le-danger-fg: #A23B32; --le-danger-bg: #F8E6E3; --le-danger-hover: #8A3129; --le-danger-pressed: #722820;
  --le-evidence-rule: #B9AE98; --le-evidence-bg: #F1EEE7; --le-highlight: #F7E6A6;
  --le-font-sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --le-font-serif: "IBM Plex Serif", Georgia, "Times New Roman", serif;
  --le-font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --le-radius-control: 6px; --le-radius-card: 10px; --le-radius-modal: 14px;
  --le-shadow-float: 0 1px 2px rgba(31,29,26,.06), 0 8px 24px rgba(31,29,26,.08);
  --le-shadow-modal: 0 16px 48px rgba(31,29,26,.16);
  --le-dur-press: 60ms; --le-dur-fast: 120ms; --le-dur-base: 180ms; --le-dur-slow: 240ms;
  --le-ease-out: cubic-bezier(.2,0,0,1); --le-ease-in: cubic-bezier(.4,0,1,1);

  /* shadcn/ui variables, set from the tokens above */
  --background: var(--le-bg); --foreground: var(--le-text);
  --card: var(--le-surface); --card-foreground: var(--le-text);
  --popover: var(--le-surface-raised); --popover-foreground: var(--le-text);
  --primary: var(--le-accent); --primary-foreground: var(--le-text-on-accent);
  --secondary: var(--le-surface-sunken); --secondary-foreground: var(--le-text);
  --muted: var(--le-surface-sunken); --muted-foreground: var(--le-text-secondary);
  --accent: var(--le-surface-hover); --accent-foreground: var(--le-text);
  --destructive: var(--le-danger-fg);
  --border: var(--le-border); --input: var(--le-border); --ring: var(--le-accent);
  --radius: 10px;
}
```
