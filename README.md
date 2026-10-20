# Surface Tension — Shifat Masud portfolio

A single-page portfolio for **Shifat Masud**, design engineer and creative technologist (Dhaka). The page is one continuous WebGL film driven by scroll: an airy near-white lake with a vivid blue brilliant-cut glass diamond floating above it, giant black type in a strict Swiss 12-column grid, and a story that moves from the surface (hero, statement, lab reels) through a stack of working glass UI tiles (his design-system work), down through the water's surface into a dive, out into space and a golden-hour journey, and back to the lake for contact. Every section has a real DOM mirror, so the text stays readable, selectable and accessible, and the page degrades to a designed static layout when WebGL isn't a good idea.

**Live:** https://shifat-surface-tension.sites.tab.bot/
(Vercel: https://shifat-surface-tension.vercel.app/ — auto-deploys from `main`.)

## Stack

- [Vite 6](https://vitejs.dev/) + TypeScript
- React 18
- three.js r170
- React Three Fiber 8 + drei
- postprocessing (custom effect chain)
- GSAP + ScrollTrigger (`@gsap/react`)
- Lenis (smooth scroll, synced to ScrollTrigger and the render clock)
- Framer Motion (DOM micro-interactions)
- zustand, Inter (variable, weight 400 only)

Exact versions are locked in `package.json` / `package-lock.json`.

## Setup

```bash
npm i
npm run dev       # http://localhost:5173
npm run build     # type-check + production build into site/
npm run preview
```

**Media unpack step.** Binary media (project reels, posters, depth maps) is stored as base64 text in `media-src/*.b64` so the repo stays text-only. `scripts/unpack-media.mjs` restores it to `public/media/` and runs automatically before `npm run build` (npm `prebuild`) and in the Vercel build command (`vercel.json`). Before `npm run dev` on a fresh clone, run it once yourself:

```bash
node scripts/unpack-media.mjs
```

`scripts/pack-media.mjs` does the reverse after you add or change files in `public/media/`.

## Architecture

```
src/
  app/        boot, single clock, section registry
  core/       math, springs, easing, frame loop
  services/   scroll (Lenis + ScrollTrigger), input, tilt, audio, loader, quality tiers
  state/      shared live props (one source of truth read by GL and DOM)
  gl/
    Scene.tsx, engine.ts     one canvas, one render loop, camera rig
    stages/
      hero/      lake + glass diamond (refraction, dispersion, light spill, tip-ripples), physics letters
      systems/   stacked glass tiles: tokens → components → product, wired to real DOM controls
      dive/      crossing the waterline, Snell's window, god rays, caustics, silt → stars
      journey/   space drift → descent → golden-hour forest → tablet reveal → liquid break-out
      lab/       project reels on bending cards (grey → colour)
    systems/     ripple sim, screen-paint fluid trail, pools, camera rig
    materials/   water, mercury
    post/        post chain + effects
    ufx/, html/  WebGL text layer and HTML-in-WebGL
  dom/
    sections/    Hero, Statement, Lab, Systems, Dive, Journey, Contact (the DOM mirror of each stage)
    ui/          header, intro/loader, cursor, odometer, overlays
  styles/        tokens first (3 type sizes, 12-col grid), then app styles
```

**Post chain.** One composer: the scene renders once into an HDR target, then a fixed chain runs — the **screen-paint fluid trail** (a half/quarter-res velocity sim driven by the pointer, composited as a smear with a thin rainbow fringe), bloom, colour grade per section (saturation, contrast, vignette, waterline), and final tone-map/dither (blue noise).

**Single clock.** Lenis, ScrollTrigger, GSAP and the R3F frame loop all read one clock, so scroll-driven camera moves, ripples and DOM reveals stay in lockstep.

Add `?grid` to the URL to see the 12-column grid overlay.

## Accessibility & performance

- **Static fallback.** Visitors without a usable GPU (software rendering, VMs, hardware acceleration off) and visitors with `prefers-reduced-motion` get a designed static page instead of the WebGL film — same content, same grid, still frames where the film had motion. `?forcegl` overrides the GPU check for testing.
- **DOM mirror.** All copy lives in real, semantic DOM; WebGL text is a visual layer on top. Skip link, keyboard-reachable controls (44 px minimum targets, visible focus rings), and the Systems tiles are driven by real buttons, a switch and a range input.
- **First paint before JS.** The HTML paints the intro/hero frame before any script arrives; the heavy 3D code starts after first paint.
- **Quality tiers.** High / mid / low tiers set render resolution, transmission buffers, march steps and particle counts; render pixels are capped on very large screens. WebGL context loss falls back to the DOM text and recovers.
- **Type discipline.** Inter weight 400 only, three type sizes, no borders, no shadows.

## Credits

All code, shaders and design are original, written for this site. Techniques (single clock, scroll sync, HTML-in-WebGL, post chain, fluid cursor trail, and the rest) were learned from Shifat's own handbook, *Lusion.co Decoded — Frontend Handbook*, and reimplemented from scratch. **No third-party site code, models, textures, copy or layouts were copied.** Project media is Shifat's own work; textures are generated or public domain.
