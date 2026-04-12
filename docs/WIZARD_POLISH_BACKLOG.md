# Curve Sync — Wizard UX Polish Backlog

Detailed TODO for the polish pass on the first-time setup wizard (`/curve/setup`).
The current skeleton is functional (forms + buttons + wired API) but
intentionally rough on the visual side. This backlog is the punch list
we'll work through together once the end-to-end flow is verified in
browser.

**Scope**: `client/src/pages/CurveSetupPage.jsx` and everything under
`client/src/components/setup/`. The polish pass should NOT change the
backend, the API contract, or the existing `CurveConfigPage.jsx` form.

**Design north star**: first-time setup on a premium phone (iPhone /
Pixel / Galaxy out-of-box experience). Warm, friendly, premium, safe,
simple. Monochrome base with the `curve` red-brown as accent.
See `docs/EMAIL_AUTH.md §5.0` for the guiding principles.

---

## 1. CurveSyncLogo — hand-tuned infinity path

**File**: `client/src/components/setup/CurveSyncLogo.jsx`

The current path is a placeholder single-sweep cubic that loosely
resembles an infinity ribbon. Replace with a hand-tuned version:

- [ ] Geometry: true figure-8 that crosses through the midpoint of the
      "C"/"c" baseline (not the ribbon sweep we have now)
- [ ] Left loop must kiss the top of the capital "C" (arrow pointing
      into the glyph from 10 o'clock)
- [ ] Right loop must kiss the tail of the lowercase "c" (arrow
      pointing out from 4 o'clock) — visual symmetry with the left
- [ ] Verify at 3 breakpoints: `max-w-sm` / `max-w-md` / `max-w-xl`
- [ ] Arrowhead size should scale with stroke width (smaller marker
      at `sm`, default at `md+`)
- [ ] Check against the existing `ArrowPathIcon` (Icons.jsx:36) for
      stylistic consistency — same stroke weight, same round caps
- [ ] Dark-mode variant: swap `currentColor` with a CSS variable so
      the polish pass can switch to cream-on-ink for a hero dark theme

## 2. CurveSyncLogo — motion timeline

- [ ] Stagger: text fades up first, THEN the path draws (currently text
      and path animate in parallel with a small offset)
- [ ] Add a subtle "ink wet" effect: the path should start at 2.5× the
      final stroke width, shrink to final over the draw (gives a felt-
      pen feel that matches the handwritten font)
- [ ] Optional: after the initial reveal, loop a slow pulse on just the
      arrowheads (opacity 0.6 → 1 → 0.6, 3 s) to suggest "live sync"
- [ ] Respect `prefers-reduced-motion`: current skeleton already passes
      `animate={!reduced}`, verify the static fallback still looks OK

## 3. HeroScreen — visual polish

**File**: `client/src/components/setup/steps/HeroScreen.jsx`

- [ ] Replace the `bg-gradient-to-b` with a softer radial or textured
      background (sand-toned, NOT a solid flat colour). Options:
      - Noise overlay (SVG feTurbulence, 2-3% opacity)
      - Radial sand-100 glow behind the logo
      - Both
- [ ] Reassurance pills — consider iconographic hover states (icon
      morph or fill) for the cursor-following pass
- [ ] CTA — add an arrow icon that slides in from the left on hover
      (use `lucide-react`'s `ArrowRight`)
- [ ] Micro-detail: a vertical hairline divider below "Saltar por
      agora" with "Curve Sync · v2" as muted meta text, bottom-center
- [ ] Tablet layout: widen `max-w-2xl` to `max-w-3xl` at `md:` so the
      logo has more breathing room
- [ ] Mobile (< sm): reduce logo `viewBox` scale + drop copy size one
      step so the whole hero fits above the fold on a 375×667 viewport

## 4. EmailScreen — step 1 polish

**File**: `client/src/components/setup/steps/EmailScreen.jsx`

- [ ] Live domain hint: as the user types, show a small `✓ Microsoft`
      / `App Password` inline badge next to the input (calls
      `/check-email` on debounce or runs `providerForEmail` client-side
      as a mirror)
- [ ] Auto-fill from `user.email` on mount (pre-populate with the
      Embers account email)
- [ ] "Usar App Password" link should be de-emphasised on hover, not
      promoted — make it a tertiary action
- [ ] Empty-state illustration: a small handwritten "@" over the input

## 5. TrustScreen — step 2 polish

**File**: `client/src/components/setup/steps/TrustScreen.jsx`

- [ ] Replace the static bullet list with an animated "what we'll do"
      preview: a tiny mock inbox showing one email being ticked, then
      one expense appearing — motion.dev sequence, 2.5 s loop
- [ ] Add a second line to each bullet: the literal scope we request
      (`IMAP.AccessAsUser.All`, `offline_access`) in code tags — builds
      credibility with technical users
- [ ] "Autorizar" button: add a Microsoft logo icon on the left
- [ ] Link to a "Saber mais sobre privacidade" modal — short text
      explaining where the tokens are stored, how to revoke, etc.

## 6. DeviceCodeScreen — step 3 polish

**File**: `client/src/components/setup/steps/DeviceCodeScreen.jsx`

- [ ] Code presentation: draw thin underlines under each character
      (like a verification-code slot) — makes the code feel official
- [ ] Copy-to-clipboard button next to the code (currently user has to
      triple-click + copy)
- [ ] QR code: add a subtle scan animation (moving line) — signals
      "scan me" more clearly
- [ ] Countdown timer: the DAG code expires in ~15 min — show a
      circular progress ring around the QR that drains
- [ ] On `pollStatus === 'pending'` for > 45 s, surface a helper line:
      "A Microsoft por vezes demora um pouco… continua à espera."
- [ ] On `pollStatus === 'error'`, a retry button (calls start again
      from this screen without going back to step 2)

## 7. SuccessScreen — step 4 polish

**File**: `client/src/components/setup/steps/SuccessScreen.jsx`

- [ ] Replace the single checkmark with a drawn-in SVG checkmark
      (motion.path pathLength reveal, 0.6 s, ease-out)
- [ ] Add a subtle confetti burst (particles-based, not canvas) — use
      `motion` + a dozen `motion.div` with random start points. Keep
      it understated (3 s total, fades out)
- [ ] Show a tiny preview of the bound mailbox's last email date:
      "Último recibo detectado: há 3 dias" (calls a new backend route
      `/oauth/preview` or reads `last_email_at` if available)
- [ ] Haptic-style vibration on mobile (navigator.vibrate(30))

## 8. PickFolderScreen — step 5 polish

**File**: `client/src/components/setup/steps/PickFolderScreen.jsx`

Added in PR 7 (functional + premium-quiet skeleton). Polish backlog:

- [ ] **Per-folder preview count** — needs a new backend route
      `POST /curve/oauth/preview-folder { folder }` that opens the
      mailbox and runs `SEARCH FROM curve` (or `FROM "curve.app"` etc.)
      and returns `{ count, latestDate }`. Render as
      *"Nesta pasta encontrámos **47 emails** do Curve — o mais recente
      **ontem às 14:23**."* under each selectable row (lazy: only the
      currently-selected folder). Transforms the step from validation
      into proof of life.
- [ ] **Selection animation** — smooth scale/highlight on the radio
      item when clicked (currently just a colour swap)
- [ ] **Scroll fade edges** — top/bottom CSS mask on the scrollable
      list when >6 folders so it's clearly scrollable
- [ ] **Recommended badge** — currently a plain pill; consider a
      tiny "✨" burst animation when the recommendation locks in
      (runs once, ~400 ms, on first render)
- [ ] **Sub-folder indentation** — parse `/` separators and indent
      `INBOX/Curve` visually so the tree is legible
- [ ] **Recency hint** — if a folder was modified in the last 7 days,
      show a muted "activa" dot — another signal the user can use
      alongside the name match

## 8b. PickFolderScreen — "Não vejo a minha pasta" escape hatch

Currently rendered as a disabled link (`title="Em breve"`). The future
behaviour is a modal / inline panel with a mini folder explorer:

- [ ] Mini tree view of the mailbox with expand/collapse on parent
      folders (lucide `ChevronRight` for collapsed, `ChevronDown`
      for expanded) — helps users who have nested structures the
      flat list doesn't display well
- [ ] Free-text fallback — a plain input where the user can type a
      folder path (e.g. `INBOX.Curve.Receipts` on certain IMAP
      providers). Validates by calling `testConnection` a second
      time with the typed folder as a hint.
- [ ] Search box at the top of the tree — `filter` over the same
      folder list, useful for mailboxes with 50+ labels (Gmail users)
- [ ] Link to docs explaining how to create a rule / filter in
      outlook.com, gmail, etc., that moves Curve receipts into a
      dedicated folder — the long-term right answer for messy
      mailboxes.

## 8c. ScheduleScreen — step 6 polish

**File**: `client/src/components/setup/steps/ScheduleScreen.jsx`

- [ ] Replace the checkbox + select with a segmented-control-like UI:
      three big cards (5 min / 15 min / 1h) with icons, plus a toggle
      at the top for on/off — mirrors iOS settings rhythm
- [ ] Preview string: "Próxima sincronização em cerca de 15 minutos"
      that updates live when the user changes the interval
- [ ] Sparkline or histogram mini-chart showing "a sincronização
      corre assim" (bogus data for now, real data post-launch)
- [ ] "Concluir" button should celebrate: slide the whole card up and
      reveal a handwritten "Tudo pronto!" below it before navigating

## 9. Shared — global polish

- [ ] `<Screen>` wrapper: add a blur-in filter (`filter: blur(6px) → 0`)
      in addition to the y-translate, for a softer page swap
- [ ] Step dots: make them clickable (forward-only) so users can review
      earlier steps without losing state
- [ ] Add a global "Deixar para depois" kebab menu in the top-right of
      every step (not just hero) — one-click exit to `/curve/config`
- [ ] Keyboard: Esc → confirm "Sair do assistente?" → back to config
- [ ] Keyboard: Enter on any step's primary button
- [ ] Screen reader: `<main aria-labelledby="setup-title">` with each
      step's title receiving the id
- [ ] Respect the system colour scheme (dark mode) with a sand-950
      inverted palette — the `curve` accent stays warm

## 10. Backend touch-ups needed for polish

These are nice-to-haves that the polish pass may surface a need for.
Add them to `EMAIL_AUTH_MVP.md` backlog if adopted.

- [ ] `GET /curve/oauth/preview` — returns `{ last_email_at, count_last_30d }`
      for the success screen's "Último recibo detectado" line
- [ ] `POST /curve/oauth/preview-folder { folder }` — opens the given
      folder and runs `SEARCH FROM curve` (or similar), returns
      `{ count, latestDate }`. Powers the "47 recibos encontrados"
      line on PickFolderScreen (§8 polish).
- [ ] `POST /curve/oauth/start` should return the MSAL `expiresOn`
      timestamp so the countdown ring on step 3 can be exact instead of
      relying on `expiresIn` + client clock drift
- [ ] Rate-limit `/poll` server-side to 1 call / 2 s to protect against
      a stuck frontend hammering the endpoint

## 11. Testing matrix

Before shipping the polished wizard:

- [ ] Happy path — personal outlook.com, happy user, completes in < 45 s
- [ ] Happy path — outlook.pt (the author's account), end-to-end
- [ ] Unsupported domain (gmail.com) → falls back to "Usar App Password"
- [ ] User cancels on step 3 → state resets, can restart
- [ ] User closes the tab on step 3 → server slot cleans up eventually
      (DAG times out on Azure's side, next poll returns 'none')
- [ ] User enters wrong code in Microsoft UI → step 3 surfaces the error
- [ ] Network failure mid-poll → error banner + "Tentar de novo" button
- [ ] `prefers-reduced-motion` — no animation, static layouts look OK
- [ ] Mobile viewport (375×667) — all 7 screens render within the fold
- [ ] Keyboard-only nav — can complete the wizard without touching the
      mouse
- [ ] Pick-folder: prefetch lands before the user clicks "Continuar"
      on the success screen (the common case) — PickFolderScreen
      renders with the list already in state, no skeleton
- [ ] Pick-folder: prefetch is still in flight when the user lands —
      skeleton renders, then folds are revealed with the stagger
- [ ] Pick-folder: prefetch fails — error + retry button work
- [ ] Pick-folder: mailbox with a `Curve` / `Finanças/Curve` folder
      gets pre-selected with the "Sugerida" badge
- [ ] Pick-folder: mailbox without any curve/receipt match falls back
      to INBOX pre-selected
- [ ] Pick-folder: user picks a different folder, continues, and the
      PUT /curve/config fires with `confirm_folder: true`

## 12. Open questions for the design session

These are decisions to make together before the polish pass starts:

- Which background treatment for the hero — flat, gradient, radial,
  noise, or a combination?
- Infinity ribbon: single draw-in or draw-then-pulse loop?
- Should the step dots be visible on the hero too? (current: hidden on
  hero, shown from step 1 onwards)
- Is the "Usar App Password" escape hatch visible on every step or
  only step 1?
- Do we want a progress bar at the top (like Stripe Checkout) instead
  of / in addition to the bottom dots?
- Does the success screen navigate to step 5 (schedule) or directly to
  `/curve/config` with a confetti toast?
