# Anduin palette mapping and UI verification — 2026-10-15

Related: [#11 palette mapping](https://github.com/Zura1555/memory-bank/issues/11), [#12 shared-token implementation](https://github.com/Zura1555/memory-bank/issues/12). The mapping was recorded in [#11's handoff](https://github.com/Zura1555/memory-bank/issues/11#issuecomment-6184488991) before application edits.

## Public source observations

Re-read the versioned first-party stylesheets and inspected the rendered [Anduin homepage](https://anduintransact.com/). These are website observations, not private product tokens or evidence of a canonical primary-button color.

| Exact observed value | Source selector and usage | Rendered check |
| --- | --- | --- |
| `#0158AE` | [Feature CSS](https://anduintransact.com/hubfs/hub_generated/module_assets/1/340696542930/1789491228557/module_Home_Page_Features.min.css), `.top-content .dot` background | Stylesheet verified; current feature markup has no matching dot/row-item elements. Do not claim a rendered blue primary action. |
| `#162950` | [Solution CSS](https://anduintransact.com/hubfs/hub_generated/module_assets/1/340664909560/1790095839629/module_Home_Page_Solution.min.css), `.solution-item-title .text` and `.dot` | Computed navy text and marker background; visually inspected solution cards. |
| `#CCD2DB` | Feature CSS, `.row-item` border and `.content-full-card` background | Computed full-card background confirmed; row-item selector was stylesheet-only in the current markup. |
| `#141414`, `#474747`, `#858585` | [Header CSS](https://anduintransact.com/hubfs/hub_generated/module_assets/1/340188938981/1789754511115/module_Header_2026.min.css), `.nav-title`, `.nav-sub-item`, `.featured-blog .tag` | Text, secondary text, muted labels in the public stylesheet. |
| `#FFFFFF`, `#E0E0E0`, `#EDEFF2` | Header CSS, `.wrap-dropdown-content`, column dividers, `.btn-item:hover` | Surface, decorative divider, hover-neutral observations. |

URLs are versioned and may change. Existing fonts, layout, component APIs, backend contracts, and original bytes are unchanged.

## Current token contract — 2026-10-18

`web/styles.css` is the source of truth: shared CSS custom properties in `:root`, overridden by `@media (prefers-color-scheme: dark)`. `web/main.tsx` imports the stylesheet and its SVG chart consumes the same chart roles as the legend. There is no separate token package, theme toggle, or generator. The operating-system/browser color preference selects the theme.

The repair restores dark-mode overrides and removes component-local color literals. Extracted spacing, font-size, and radius values preserve their existing sizes; the light theme retains the incumbent blue/navy identity. Primary actions, muted text, placeholders, and control boundaries use contrast-safe roles.

### Application assignments

These role assignments are application decisions. Pale/quiet surfaces, functional borders, and **all dark-mode values** are application accessibility/visual derivations, not claimed exact Anduin tokens.

| Role | Light | Dark |
| --- | --- | --- |
| `--accent`: actions, selection, evidence accents, focus | `#0158AE` | `#77B5FF` |
| `--accent-strong`: hover, links, emphasized text | `#162950` | `#BDD8FF` |
| `--accent-pale`: selected/evidence surfaces | `#EDF5FF` | `#192E4A` |
| `--on-accent`: filled-action text | `#FFFFFF` | `#101B2D` |
| `--ink` / `--muted` | `#162950` / `#526277` | `#EDF2FA` / `#B6C2D5` |
| `--paper` / `--surface` | `#F4F7FB` / `#FFFFFF` | `#101B2D` / `#162239` |
| `--line`: decorative dividers | `#E2E8F0` | `#394B68` |
| `--control-border`: functional boundaries | `#738095` | `#8291A8` |
| `--quiet`: inset/disabled surfaces | `#F8FAFC` | `#1B2A43` |
| `--success` / `--success-pale`: existing semantic green | `#15544F` / `#E4F2EE` | `#B8E5DC` / `#203A38` |

Removed hue-named `--teal*` brand roles and conflicting green brand borders/surfaces. Dialog, picker, checkboxes, selections, and all four workflow steps share the same accent roles. Semantic success/available/ready/verify remains green; partial/warning/adapt remains amber; failure/unavailable remains red; unknown remains neutral. Existing visible labels still carry meaning independently of color.

Accessibility deviations: low-contrast public-site grays are not copied into small text or functional boundaries. Muted text and placeholders use `--muted`; inputs use `--control-border`, not decorative `--line`. Disabled actions use readable muted text and quiet surfaces instead of fading the whole control. Dark filled actions use dark text on light blue rather than white on that blue.

### Shared scales and component roles

| Family | Tokens and use |
| --- | --- |
| Spacing | `--space-1` through `--space-8`: .25, .5, .75, 1, 1.25, 1.5, 1.75, 2rem; repeated padding, margins, and gaps. |
| Type | `--text-xs`, `--text-sm`, `--text-detail`, `--text-body`, `--text-lead`, `--text-base`: .75, .8, .85, .9, .95, 1rem. Title roles: 1.05/1.1/1.2rem; heading/display roles preserve the existing fluid clamps. |
| Radius | `--radius-sm`, `--radius-control`, `--radius-md`, `--radius-card`, `--radius-panel`, `--radius-lg`, `--radius-dialog`, `--radius-pill`: .5/.55/.65/.85/.95/1/1.1rem and 999px. |
| Motion | `--motion-fast` 120ms, `--motion-tooltip` 140ms; shared easing roles. Reduced-motion preference uses `--motion-reduced` (.01ms). |
| Color and elevation | Existing semantic roles plus themed borders, placeholders, backdrop, focus/selection rings, and action/tooltip/dialog shadows. `--chart-*` is shared by SVG and legend; `--avatar-*` keeps stable categorical identities with separate foreground roles. |

Use semantic colors (for example, `color: var(--muted)`) and the matching existing scale value (for example, `gap: var(--space-3)`). One-off geometry, breakpoints, and component-specific sizes remain local; do not add a token for every literal. `--accent-bright` and `--accent-bar` are decorative; readable accent text and primary fills use `--accent`, and primary hover uses `--accent-strong`.

### Current contrast and verification

Computed browser token values, WCAG sRGB relative-luminance calculation; ratios rounded to three decimals. Text pairs exceed 4.5:1; focus/control pairs exceed 3:1. Palette-pair checks are not a complete accessibility certification.

| Pair | Light | Dark |
| --- | ---: | ---: |
| Filled primary text/background | 6.981 | 8.086 |
| Hover primary text/background | 14.314 | 11.860 |
| Disabled text/quiet surface | 5.952 | 7.997 |
| Main text/surface | 14.314 | 14.132 |
| Muted text/paper | 5.796 | 9.589 |
| Placeholder/surface | 6.227 | 8.825 |
| Focus accent/surface | 6.981 | 7.442 |
| Functional border/surface | 4.000 | 4.966 |
| Success badge | 7.557 | 8.864 |
| Warning badge | 5.576 | 8.986 |
| Error badge | 5.785 | 8.271 |
| Unknown badge | 5.529 | 6.972 |

- `npm run typecheck && npm test && npm run build`: passed, 60 TypeScript tests and one Python test. Build retains the >500kB client-chunk advisory.
- Chromium exercised the actual app at 1440×1000 and 320×1000 in both schemes: preference switching, template selection, empty-request disabled state, textarea focus, mobile drawer Escape/focus return, source selection, and exact-passage inspection. No horizontal page overflow or browser runtime exceptions in those scenarios. Six representative elements retained identical computed font size, radius, padding, gap, and width against the pre-change app at both viewport sizes.
- The UI preview used real local HTTP handlers and retained corpus/original files through a temporary read-only Node storage adapter. Indexing/provider configuration was unavailable in that adapter and remained visibly unconfirmed; no indexing or model qualification is claimed. All mutating API methods were blocked. No paid calls, uploads, deployment, or backend changes.
- [Current contact sheet](images/design-tokens-2026-10-18.webp): light above dark, desktop beside 320px, with the focused request field. Reduced-motion emulation resolves shared transitions to .01ms in both schemes.

## Historical contrast — 2026-10-15

The remaining measurements, runtime log, and screenshot record below were recorded for the earlier stylesheet on 2026-10-15. They are historical evidence, not verification of the current token values.

WCAG sRGB relative-luminance calculation; ratios rounded to three decimals. Normal text requires 4.5:1, large text and applicable control/focus indicators 3:1.

| Pair / observed role | Light ratio | Dark ratio |
| --- | ---: | ---: |
| Filled primary text/background | 6.981 | 8.086 |
| Hover/active primary text/background | 14.314 | 11.860 |
| Disabled action text/quiet surface | 8.657 | 7.997 |
| Main text/surface | 18.423 | 14.132 |
| Muted text/paper | 8.066 | 9.589 |
| Emphasized text/accent-pale | 12.681 | 9.425 |
| Accent focus/surface | 6.981 | 7.442 |
| Accent selection boundary/accent-pale | 6.184 | 6.426 |
| Functional border/surface | 4.000 | 4.966 |
| Functional border/accent-pale | 3.543 | 4.288 |
| Available badge text/background | 7.557 | 8.864 |
| Partial badge text/background | 7.033 | 8.532 |
| Unknown badge text/background | 7.964 | 6.902 |
| Evidence error text/background | 8.040 | 9.657 |

Browser inspection audited computed text colors against composited ancestor backgrounds for the exercised screens, dialog states, and open picker: 190 light and 208 dark pair observations. Lowest observed text ratios were **6.132:1** light (inline blocker) and **6.902:1** dark (neutral contrast badge), above normal-text AA. Desktop mouse hover, held active state, disabled state, and keyboard focus were inspected separately with fine-pointer/hover capabilities enabled; focus outlines were 3px. This is contrast and interaction evidence, not a complete accessibility certification or screen-reader session.

## Historical runtime verification — 2026-10-15

- `npm run typecheck && npm test && npm run build`: passed; 11 TypeScript tests and one Python validation test.
- `npm run ingest -- --root /tmp/memory-bank-palette-ingest-t41o3k4e`: passed against a temporary corpus/contracts copy; the frozen tracked corpus and import timestamps were not rewritten.
- `npm run publish:corpus`: published 24 exact originals plus the manifest into the task worktree's **local** R2. `npx wrangler dev --ip 127.0.0.1 --port 8787 --inspector-port 9241` served the built UI and real evidence endpoints. No provider key or database binding was given to this verification Worker.
- `node --experimental-strip-types src/server/evidence.smoke.ts`: passed navigation-mode API routing, original SHA-256, and passage identity.
- Chromium browser tool ran a temporary `/tmp/memory-bank-palette-browser.js` harness through `tab.run`: **51 checks passed**, zero browser runtime errors. Replayed the existing historical P1 checked assessment and checked brief from job `2d27d701-e360-4ca5-83c3-4208fc0aff74`; only job/create/brief responses were intercepted. Passage retrieval and downloads used real local Worker/R2 endpoints. This historical replay does **not** qualify the final AI workflow.
- All four steps exercised at 1440×1000 and 320×1000 in light and dark mode. Checked disabled/enabled actions, evidence loading/503/success, keyboard opening and Escape/focus return, work selection, and the submitted selected case/artifact/version/passage identity.
- The current corpus contains no multi-version artifact. A separate, explicitly UI-only `qa-picker-second-version` reference exercised the existing Base UI picker in all four viewport/scheme combinations. Pointer and keyboard switches cleared old passage selections; brief submission remained blocked until a new passage was chosen. This fixture is not published evidence and was never sent to a real brief endpoint.
- A subsequent real browser link click completed download of `map-2025-02-11`: 1,216 bytes, SHA-256 `7dd4e8ae29cdd878b579364f03207430cfd0e904b7e75eeb01e4f9bfaf09644a`, matching the manifest.

No paid calls, admission/accounting changes, deployment, or new framework/dependency. The unresolved dispatch and qualification gate in [#2](https://github.com/Zura1555/memory-bank/issues/2) are unchanged.

## Historical screenshot record — 2026-10-15

Each contact sheet contains steps 1–4, verified evidence, retrieval error, selected passages, and the open picker. Narrow captures preserve the existing layout; this change does not redesign it. Picker captures include the labelled UI-only second-version fixture. Loading and button-focus captures were also inspected during the smoke.

| Scheme | Desktop | 320px |
| --- | --- | --- |
| Light | [Contact sheet](images/anduin-palette-light-1440.webp) | [Contact sheet](images/anduin-palette-light-320.webp) |
| Dark | [Contact sheet](images/anduin-palette-dark-1440.webp) | [Contact sheet](images/anduin-palette-dark-320.webp) |

Repeat the README's browser smokes against an existing checked-result replay without paid calls; measure both schemes' computed colors, exercise keyboard and pointer states, and keep fixture UI proof separate from live AI-workflow qualification.
