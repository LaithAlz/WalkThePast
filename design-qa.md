# Design QA — Walk the Past Light

## Comparison target

- Source visual truth: `/Users/marwan/Downloads/Walk the Past.zip` → `Walk the Past Light.dc.html`, screen `00 · LANDING, SIGNED OUT — 1440×900` (plus its upload, library, exploration, and evidence-mode screens).
- Implementation: `http://127.0.0.1:5173/` rendered in the Codex In-app Browser.
- Implementation visual evidence: browser captures made 2026-09-19 during this QA pass (landing, exploration, evidence mode, and library). The browser capture facility does not persist a filesystem path.
- Viewport: 1280 × 720 CSS px, browser density 1×. Source is a 1440 × 900 design board; comparison was normalized by preserving its desktop layout proportions rather than comparing browser chrome or canvas margins.
- State compared: signed-out landing, sample-world exploration, evidence mode, and personal library.

## Full-view comparison evidence

The implementation preserves the light background, blue radial lift, mono uppercase labels, serif/italic display hierarchy, two-column landing composition, historical photo framing, evidence chips, three-step method block, library grid, and full-bleed exploration view from the source. The source's supplied historical photos are now project-local assets, avoiding external image load failures.

Focused comparison was used for the hero image/card, evidence legend and overlay, and library-card typography because those are the dense fidelity regions. The historian orb is a project-local generated raster asset rather than a CSS/HTML approximation.

## Required fidelity surfaces

- **Fonts and typography:** Instrument Serif, IBM Plex Mono, and Manrope are loaded to recreate the source's display, annotation, and UI hierarchy. The headline italic and label tracking match the source language.
- **Spacing and layout rhythm:** Desktop content is constrained to a 56px-style side gutter, with the source's two-column hero, 18px image radius, 28px card gaps, and full-bleed exploration behavior.
- **Colors and visual tokens:** White / near-white canvas, charcoal text, `#4F7CFF` action blue, source green, inferred amber, and unsupported purple align with the reference.
- **Image quality and asset fidelity:** Historical photographs are saved in `public/assets/` and use object-fit cropping appropriate to their source slots. The voice historian uses `public/assets/historian-amber-orb.png`.
- **Copy and app-specific text:** Landing, guest upload, library, making, exploration, and evidence copy follows the reference screens.

## Findings

- No actionable P0, P1, or P2 visual mismatches remain at the tested desktop state.
- [P3] The supplied design includes a distinct Milan source photo. Wikimedia rate limiting prevented that optional sixth download during this build; the fifth library card intentionally reuses the available boulevard source while retaining its reference copy.

## Interaction checks

- Landing **Log in** and **Sign up** open their respective custom Clerk-backed states.
- The custom sign-up flow collects email/password, requests Clerk's email verification code, and finalizes the created session after verification.
- The custom login flow submits email/password to Clerk, handles Clerk device-trust email verification when required, and finalizes a successful session.
- The login state explicitly reads **No account? Sign up**; the sign-up state provides the reciprocal login link.
- Landing **Walk a sample world** opens exploration.
- **Evidence mode** toggles the provenance overlay, legend, source-camera frame, copy, and historian color.
- `E` toggles evidence mode and holding `Space` animates the historian response state.
- **Leave world** returns to the library.
- Upload routes provide browse/sample-world paths and selected files move to the making state.

## Comparison history

1. Initial landing capture found all remote design images blocked in the local preview (P1). Fixed by adding the supplied Wikimedia source photos as project-local files and switching each consuming component to local paths.
2. Second landing capture found the desktop content aligned to the viewport edge (P2). Fixed by applying the source's desktop gutter to landing, upload, library, and grid containers.
3. Final captures of landing, exploration, evidence mode, and library show no actionable P0/P1/P2 issues.

## Implementation checklist

- [x] Recreate white-mode landing and method section.
- [x] Implement guest upload, auth, library, making, exploration, and evidence screens.
- [x] Make primary navigation and state transitions work.
- [x] Localize visual assets and verify a production build.

## Follow-up polish

- [P3] Add the optional unique Milan archive photo if Wikimedia access is available later.

final result: passed
