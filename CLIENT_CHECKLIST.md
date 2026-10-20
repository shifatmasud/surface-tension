# Shifat's checklist (every requirement he gave, Oct 19 2026)
Tick an item only when it runs on the live site and was checked visually.

## Scope & handoff
- [ ] Single home page prototype, original (techniques learned from his handbook, no Lusion code/assets/layouts/copy)
- [ ] Every technique from all 15 handbook chapters implemented; Chapter 14 1:1 in behaviour
- [ ] Public GitHub repo on shifatmasud + live on his Vercel
- [ ] Done by Wed Oct 21, 9 PM Dhaka

## Stack
- [x] React + TS + Vite, R3F, GSAP + ScrollTrigger, Lenis, Framer Motion — verified 06:25Z (w9): live build bundles all five; package.json deps + src/services/scroll.ts (Lenis + ScrollTrigger), Framer Motion in Intro/Header/ProjectOverlay, tsc strict
- [ ] three-html-render (his fork's base) with fallbacks; drei Html for crisp labels
- [x] WebGL2 — live console on real GPU: 'renderer: WebGL2'

## Look & feel
- [ ] Clean, calm, cinematic in every visual; cinematic minimalism
- [ ] Minimal Swiss-style composition (strict grid, asymmetry, flush-left type) built on cinematic composition rules (thirds, lead room, negative space, depth layers)
- [ ] Every section is a stage with exactly one star
- [ ] Premium quality per section, iterated visually (not just code)
- [ ] Spacious & immersive
- [x] No UI shadows, no borders — live DOM audit 03:31Z: 0 elements with a border, 0 with a box-shadow
- [ ] UI theme only black / white / gray
- [ ] 3D scenes vibrant colour
- [ ] Only creative abstract 3D that tells the story (no meaningless 3D)
- [ ] Visuals and text enhance each other, never duplicate
- [ ] Each section tells a meaningful story and ends on a hook that pulls you to scroll on
- [ ] Cognitive psychology principles applied (curiosity gap, peak-end, Von Restorff, Gestalt, cognitive load, chunking, serial position, Fitts/Hick, Zeigarnik)
- [ ] Signature: water, liquid glass, smooth fluid motion

- [ ] Layout & section design inspired by lusion.co (principles, not traced)

## Type & icons
- [x] Inter, Regular weight only — live DOM audit 03:31Z Oct 20: every visible text node computes to Inter Variable, weight 400
- [x] Max 3 type sizes, big size contrast — live DOM audit 03:31Z: exactly 12.5px / 18px / 201.6px at 1440
- [x] Phosphor icons — verified 06:25Z (w9): @phosphor-icons/react in the live header (SpeakerSimpleHigh/Slash sound toggle, ArrowUpRight) and the project overlay

## Hero
- [ ] 3D calm rippling water lake with a blue 3D glass diamond on top
- [ ] Real water optical properties via approximations (beauty + performance over hyper-realism)
- [ ] Water looks physically believable, not fake

## Cursor & interaction
- [ ] Global cursor screen-paint fluid trail (Chapter 14)
- [ ] Accumulated iridescence on trail fringes, like the original
- [ ] Cursor trail 1:1 in look & behaviour with lusion.co (side-by-side verified; fresh code)
- [ ] Parallax & depth
- [x] Mouse-move tilt — live real-GPU frames 04:25Z Oct 20 (pointer left vs right: camera parallax shifts the frame and the gem tilts toward the pointer)
- [x] Odometer counters — live 04:25Z: intro 000→100 reel counter; lab index rolls as digit reels (DOM read 01→04 / 05 while scrolling)
- [x] Subtle cylinder bend tied to scroll velocity — live real-GPU 04:45Z: bend forced to ±0.35 (QA hook) visibly curves the lab track; velocity→bend mapping (vel/4000 px/s, damped) in labGL; real-scroll magnitude not captured (remote browser 1–17 fps)
- [x] Depth-map 3D image parallax — live real-GPU frames 05:13Z Oct 20 (Water Sim card held on its poster, parallax pointer forced to opposite corners: 19% of the card's pixels shift along the depth map; same pointer twice = no change)
- [x] Mask slide-up text reveals — live 04:30Z statement sweep (12 frames): phrases rise through the mask line by line and sink upward; lab names slide up per project

## Journey section (before CTA)
- [x] Red crewmate (our own model) drifts in space — live 1440+390 shots 03:25Z (m6-journey-space-live-*)
- [x] Lands in a green forest — live 1440+390 03:25Z (m6-journey-forest-live-*); forest upgraded with grass, sun rays, mist
- [x] Camera pulls back: forest was inside a tablet (no Apple logo) — live 1440+390 03:25Z (m6-journey-reveal-live-*)
- [x] Crewmate breaks out through the screen as a liquid ripple, into the CTA — live 1440 frames at p .84/.92/.99 03:05Z (membrane bulge, rings, droplets), droplets land on contact water

## Media & sound
- [ ] Media from cosmos.so / public-domain sources, project reels from his demos
- [x] Web Audio synthesized sounds, muted until first gesture, Phosphor toggle — verified 06:25Z (w9): services/audio.ts synthesizes every sound with oscillators/noise, enabled=false until the Phosphor speaker toggle is pressed (AudioContext resumed on that gesture)

## Quality bars
- [ ] Accessibility (real DOM text, keyboard, reduced motion, AA contrast)
- [ ] Performance (Lighthouse 90+, adaptive quality)
- [ ] Phone optimized
- [ ] Responsive, adaptive design (layout, type and 3D adapt across phone, tablet, laptop, ultrawide; touch vs pointer)
- [ ] Smooth scroll on all devices

- [ ] Matches Shifat's favourite reference (docs/north-star-reference.jpg): airy off-white field, one vibrant glass 3D object as the star, huge black display type bottom-left, tiny two-line caption baseline-aligned bottom-right


## Added Oct 20 04:54Z (Shifat, WhatsApp m:f27ebb63)
- [x] Dive/water scene: screen-space god rays (volumetric light shafts, occlusion-aware, from the sun through the surface) — verified live 05:46Z on a real GPU at 1440 + 390 (m9-dive-live-*.png, m9-dive-strip-1440.jpg); re-shot live 06:03Z (w9)
- [x] Dive: ultra-realistic caustics (sharp, bright, refracted light network on sand & objects, animated, with chromatic split) — verified live 05:46Z on a real GPU at 1440 + 390 (m9-dive-live-*.png, m9-dive-strip-1440.jpg); re-shot live 06:03Z (w9)
- [x] Dive: underwater vegetation (kelp/seagrass swaying with current, rim-lit, depth-faded) — verified live 05:46Z on a real GPU at 1440 + 390 (m9-dive-live-*.png, m9-dive-strip-1440.jpg); re-shot live 06:03Z (w9)
