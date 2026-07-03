# CLAUDE.md

Conway's Game of Life — full-page canvas app, TypeScript + Vite, no runtime
dependencies. Extracted from the original Delphi-port playground repo; the
Delphi original and a Lazarus/FPC native port live in
`~/Developer/LifeGame`, not here.

## Commands

- `npm run dev` — dev server on http://localhost:5173
- `npm run typecheck` — `tsc --noEmit` (TypeScript 7 / native compiler)
- `npm run build` — production build

There are no unit tests in-repo. The engine was verified by bit-comparing
generations against an independent brute-force reference (400+ generations
per scenario: fresh soup, mid-run refill, grow/shrink resize, ring stamps,
rule switches). If you change `makeStage`, `resize`, `stampRing`, or the
rule masks, re-verify the same way: compile `ts/LifeGame.ts` standalone,
drive it from a small Node script next to a naive reference implementation,
and require bit-identical fields every generation.

## Architecture

- `ts/LifeGame.ts` — pure engine, no DOM access except a scratch canvas for
  CSS color parsing.
  - Field and all bookkeeping are flat typed arrays; index = `y * width + x`.
  - Change-list algorithm: `changed` holds cells that flipped last
    generation; candidates = changed cells + 8 neighbours, deduped via a
    generation-stamped `Uint32Array` (never cleared). When
    `changedCount * 4 >= total` it falls back to a full sweep — that path is
    always correct and cheaper at high activity.
  - `changedCount === total` is a sentinel meaning "treat every cell as
    changed" (list contents ignored); set after `fillField`/`resize`/`setRules`.
  - Rules are two bitmasks (`bornMask`, `surviveMask`), bit n = transition
    applies at n live neighbours. Border cells unconditionally die — a
    deliberate quirk kept from the 2012 Delphi original.
  - `print` is sparse: it repaints only changed cells into a persistent
    ImageData. `print` and `makeStage` must alternate strictly (the rAF loop
    does); a second `makeStage` without a `print` between drops pixel updates.
  - `stampRing` cells enter both the change list and a one-frame "stamps"
    list; stamped cells render in the accent color exactly once, then revert.
  - `fillField` runs `SETTLE_GENERATIONS` invisible generations so the dense
    soup phase (which collapses within 1–2 generations at 80% fill) is never
    rendered.
- `ts/main.ts` — everything DOM: rAF loop, resize (debounced 200ms — live
  window-dragging fires per-pixel events), click ripples, god's-touch
  wanderer, control panel wiring.
  - Ripples reflect off edges via image-source mirrors: each wavefront also
    stamps from centers mirrored across the walls/corners; a mirrored ring
    reaches the field exactly when the real wave hits the edge.
  - The god wanderer follows a Catmull-Rom spline through random waypoints.
    The stepper walks travel distance across segments so the parameter t
    never leaves [0,1) — evaluating the cubic outside extrapolates and
    teleports the dot (this was a real bug; don't reintroduce it). Waypoints
    closer than 80px to their predecessor are regenerated for the same reason.
- Colors are CSS custom properties in `index.html` (palette borrowed from
  mellonis-workspace/site), read from computed style every frame; a palette
  change (e.g. OS theme switch) triggers a full repaint automatically.
  Canvas color parsing must handle both `rgb(...)` (computed style) and
  `#rrggbb` (canvas fillStyle readback) — fillStyle serializes opaque colors
  as hex, which once caused an all-black-screen bug.

## Conventions

- Tabs for indentation in `.ts` (matches existing code).
- No frameworks, no runtime deps; keep it that way unless asked.
- Comments only for non-obvious constraints (see existing ones); no
  narration comments.
