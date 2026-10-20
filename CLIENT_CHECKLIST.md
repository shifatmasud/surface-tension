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
- [x] Global cursor screen-paint fluid trail (Chapter 14): the original Lusion-parity trail — restored live 09:27Z index-iIuS-AU-.js (byte-identical to the pre-v2 bundle), real-GPU frames 1440/390
- [x] Accumulated iridescence on trail fringes, like the original — parity trail, live index-iIuS-AU-.js
- [~] RETIRED: own fluid trail v2 (was live 09:24–09:27Z, index-Dqq_cqjq.js). Shifat 09:23Z preferred the original; files removed from the repo and from v2 staging
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


## Added Oct 20 07:58Z (Shifat, WhatsApp m:912ce9fb)
- [ ] Section transitions art-directed, smooth, high quality (current feel choppy/poor). Each section is its own clipped scene: no scene morphs into another section's scene. Deliberate transition per boundary.

## Added Oct 20 08:03Z (Shifat, WhatsApp m:b55c2a5d)
- [ ] Diamond's reflection visible on the water (hero + contact)
- [ ] Every scene cinematic (composition, light, lens, motion)
- [ ] Crewmate shatters the tablet's glass when he comes out — dramatic, cinema-grade (shards, refraction, slow-mo beat, sound)
- [ ] 3D asset placed directly on top of bold flat display type for a high-end popping effect (product-marketing style) in key frames
- [ ] Iridescent, fringed materials: liquid glass, plastic, metal (thin-film interference, dispersion) on 3D objects
- [ ] Composition rule: key element obvious; kill anything stealing attention; use empty space to push attention to the key element
- [ ] Every number change animates as an odometer (rolling digits) everywhere
- [ ] Journey first scene: starry outer-space sky behind the crewmate (Shifat 08:04Z m:142b83a8)
- [ ] 3D object over big type ONLY in CTA section, true refractive 3D glass (type bends through it) (Shifat 08:05Z m:d827cda9) — supersedes hero/statement staging
- [ ] Diamond hero object continuously travels through almost every section as the guide, leading focus; hidden only in the crewmate scene; ends as CTA glass object (Shifat 08:07Z m:44ed3a10)
- [ ] Every section has layered parallax scroll (Shifat 08:08Z m:4fc14582)
- [ ] Parallax: foreground faster than background; scale/atmosphere make z-depth easy to read (Shifat 08:11Z m:347207c3)
- [ ] Any unavoidable cut uses a smooth particle-shatter blurry fade (Shifat 08:12Z m:aa989e2b)
- [ ] Colour contrast for depth: foreground lighter & warmer, background darker & cooler (Shifat 08:13Z m:231da215)
- [ ] Depth of field: near sharp, far progressively blurrier (Shifat 08:13Z m:78ef8690)
- [ ] Dive 'keep scrolling back to the surface' bar cleaner; NO gradients anywhere in UI (Shifat 08:16Z m:21a169b1)
- [ ] Accessibility: WCAG AA contrast on every text over every scene, legible sizes, keyboard nav, focus ring, aria, reduced motion; Lighthouse a11y 95+ (Shifat 08:19Z m:7c841b33)
- [ ] Odometer on all numbers = FIRST task (Shifat 08:19Z m:7c841b33)
- [ ] Principle: flat, clean, calm text/UI paired with expressive cinematic 3D storytelling (Shifat 08:20Z m:985c7ab5)
- [ ] Mobile performance mastery: adaptive quality 60fps, visible-only render, half-res post, precompiled shaders, compressed assets, instant text paint; Lighthouse mobile 90+ (Shifat 08:22Z m:d5c80a4a)
- [ ] AAA-game-quality water (hero/contact lake), optimized for mobile 60fps (Shifat 08:24Z m:43ef075e)

## STRUCTURE v2 (Shifat 08:32Z m:16d14f4f) — see STRUCTURE-v2.md
- [ ] Scene 1 water: hero diamond floating + reflected on lake → sinks under water → projects appear underwater (lab/statement folded in)
- [ ] Scene 2: Shade DS clipped scene, unconnected to the water/diamond
- [ ] Scene 3: crewmate (space → breaks tablet glass) → bursts into black-wall CTA, crewmate on top of huge white type, interactive stickers on the wall
- [ ] Each scene clipped
- [ ] Sticky footer revealed as the CTA scrolls up
- [ ] Diamond guide limited to Scene 1 (supersedes 'every section')
- [x] Outgoing section never scales or dims on transition out: holds 100% scale + full brightness, drifts up slower (parallax) while the next card slides over (Shifat 08:37Z) — live 08:46Z index-BjTvolbQ.js, real-GPU frames 1440/390 at card travel .40/.75

## Hero per scene (Shifat 08:54Z m:842d8a9d)
- [ ] Scene 1 (hero + projects): the DIAMOND is the hero; project cards slide over the diamond underwater
- [ ] Shade DS: the system figure is the hero
- [ ] Crewmate scene: the crewmate is the hero
- [x] Fluffier, better grass & trees in the crewmate scene — live 09:59Z index-DNm_eG7U.js (foliage helper 6a97ca2b), real-GPU frames 1440/390
## Also 08:51–08:52Z
- [ ] Preloader black, exits like a curtain (m:520317ca)
- [ ] Scroll up & down both smooth; every section stays (m:ea07bf4d)
- [ ] Underwater caustics = glowing additive light (m:edf8656c) — module by 8c2362cf, hooked by builder
- [x] Preloader black (#000, white odometer counter) and exits like a curtain: slides up (expo in-out, ~1.05 s) over the already-rendered hero; no white flash (inline black bg until lifted); reduced motion = quick fade (Shifat 08:51Z) — live 09:0xZ index-iIuS-AU-.js, real-GPU frame strips 1440/390
- [ ] Keep the current under-the-sea section within Scene 1 (m:48ff42d0)
- [x] Preloader: 3D glossy plastic model of Shifat's official logo (shifat-logo.jpg), rotating horizontally (m:a4507002) — live 09:56Z index-8X47ha2V.js, real-GPU strips 1440/390 (spin + curtain exit, no white flash)
- [ ] Project slide morphs into its detail card on click (shared-element), morphs back on close (m:03b7b243)
- [x] Flat SVG logo used for all branding: nav, footer, favicon, apple-touch, mask-icon, OG image (m:9f6a26dd) — live 09:56Z index-8X47ha2V.js
- [ ] Keep the current under-the-sea dive beat intact inside Scene 1 (god rays, kelp, bubbles, tool numbers), then the projects in the same shot (Shifat 09:11Z) — staged on shifat-v2-preview, not live
- [ ] Project slide morphs into the detail card on click (shared-element FLIP/GL morph, 600–750 ms, reverse on close, dialog a11y, swipe-down on phones) (Shifat 09:16Z)
- [ ] Every element tells a beautiful story: one narrative thread, each element has a story job (m:26bef796)
- [x] REVERT cursor trail to the original Lusion-parity trail (pre-v2, as live before 09:24Z) per Shifat 09:23Z m:a07a1540: 'Keep original lusion.co trail please. It was better'. Trail v2 is retired. — live 09:27Z index-iIuS-AU-.js (hash checked), GitHub 0670bd1..86c58ee, v2 tree reverted too; real-GPU frames 1440/390
- [ ] Cursor trail = true match of the original from his decoded repo + handbook (study all consumers, not just ScreenPaint); current parity port 'seems lacking' (m:39084d5a)
- [ ] Mobile parity on everything: every feature designed + QA'd at 390 touch as carefully as desktop (m:e5b00cb1)
- [ ] P0 BUG: sections turn black & freeze when scrolling past; trail must stay alive persistently, no freeze (m:b3d9218f)

- [x] Sections never turn black or freeze at boundaries: the block you scroll into renders live (both directions), stills refreshed every frame; cursor trail is one global always-live layer (Shifat 09:38Z) — live 09:51Z index-BasG7Y3D.js, real-GPU strips 1440/390
- [ ] Logo lockup = mark + "Shifat" only, no dot after name (m:4ba63a11)
- [ ] Best preloading strategy: better UX without sacrificing performance; before/after numbers (m:4ba63a11)
- [ ] Virtual scroll like lusion.co for smooth scroll, desktop + phone (m:bc0a9be7)
- [x] Logo lockup = flat mark + "Shifat" only, no dot after the name (nav, footer, OG) (Shifat 10:06Z) — live 10:11Z index-B05FrcGC.js, frames 1440/390

- [x] v3 structure live (Shifat 13:24Z-14:44Z): tablet -> space -> tunnel -> forest, black sticker wall with odometer CTA, frosted card morph, sharp full-density text, preloader logo clipped to the panel, footer pill + loop wrap -- live 15:28Z index-Dq2QMKTR.js (hash checked), GitHub 93e927f; frames 1440/390 (hero, statement, dive, lab, systems, tunnel, forest, CTA/footer); no console errors; frame loop advancing in every scene
- [x] Cold deep-jump to the footer lands on the wall (stages prewarm in idle after the hero; camera cuts on a pose jump) -- live 15:28Z index-Dq2QMKTR.js
- [x] Card morph 1440 + 390: open, close button, Esc, focus trap both directions, reopen (1440 proven with Web Animations time driven step by step) -- live 15:28Z index-Dq2QMKTR.js
