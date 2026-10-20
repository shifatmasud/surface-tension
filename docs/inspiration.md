# Inspiration study — lusion.co, read live (2026-10-19/20)

Studied live in a real-GPU browser session at 1440×900 and 390×844: home page scrolled top to bottom (wheel-driven, their own smooth scroller), menu opened, a work card hovered, one project page opened and scrolled. Every number below was read from the DOM (`getBoundingClientRect`, computed styles) or from the screenshots in `/home/user/tab/tasks/011cf21d-6b66-4421-bfe6-6de908d3895c/inspiration/` (`d10–d48` desktop scroll frames named by scroll position, `d60–d62` menu, `d63–d65` work cards at rest / hover, `d70–d72` project page, `m01–m09` phone; raw DOM logs in `d-scrolllog-*.json`).

**Authority order for our build:** `docs/north-star-reference.jpg` (Shifat's favourite frame) > lusion.co. Where they disagree, the reference wins; lusion is the source for pacing, scale rhythm and interaction grammar, not for frames.

What the reference frame is (measured on the 1086×1448 image, portrait): light off-white field; ONE vibrant blue glass 3D object, centred horizontally, its mass inside the upper ~60 % of the frame (centre at ≈ 36 % height); huge black two-line display type flush-left in the lower third (cap height ≈ 11 % of frame height, line pitch ≈ 1.0); a tiny two-line caption bottom-right whose last baseline aligns with the display's last baseline; nothing else — no header chrome, no border, no shadow, no card.

---

## 1 · What I observed (with numbers)

### 1.1 Page anatomy and pacing — desktop 1440×900
Total scroll length **51,555 px = 57.3 viewports**. Seven DOM sections, one fixed full-frame WebGL canvas (1440×900, `position: fixed`) under everything; `html, body { overflow: hidden }` and a transform-driven virtual scroller (no Lenis on `window`; their own).

| # | section | height px | in viewports | what happens |
|---|---|---|---|---|
| 1 | hero | 900 | **1.0** | 3-line 36 px headline top-centre-right; dark rounded "frame" with 3D jacks filling the lower 75 %; loader counts to 100 first |
| 2 | reel | 2,533 | **2.8** | 144 px display "Bold Ideas, Brought to Life" flush-left, 21.6 px paragraph in the right half, a blue 3D ribbon crossing the frame; then a ≈1.5-viewport stretch where a 108 px uppercase "PLAY REEL" marquee sits almost still (parallax ≈ 0.3) over the reel video |
| 3 | featured work | 3,904 | **4.3** | 115 px "Featured Work" + 12 cards in 2 columns (details §1.4) |
| 4 | goal (the 3D journey) | 39,855 | **44.3** | 115 px 3-line statement + cyan 3D ring + tablet shot (≈1 vh), then a dark takeover, a justified uppercase headline you fly *through*, then ≈31 viewports of astronaut journey with **zero DOM copy** |
| 5 | end (CTA) | 3,150 | **3.5** | "Let's work together!" 144 px centred white on black, astronaut + toy stickers |
| 6 | footer | 900 | 1.0 | 4 columns: address, links, newsletter (38 px), © line |
| 7 | scroll-nav | 313 | 0.35 | "Keep scrolling to learn more → About Us" (50 px); over-scrolling past the end **navigates to the next page** (my scroll ended on /about twice) |

Rhythm as the viewer feels it: **8 viewports of "page"** (type + grid, light field) → **44 viewports of cinema** (dark, one star, scrubbed camera, no copy for ≈31 of them) → **4.5 viewports of ending** (CTA + footer). Calm:peak ≈ 1:5 by length. The transition into the peak is a single device: the headline fills the width, then scales ×30 (the word "a new" measured 3,349 px wide at y 18.4 k) so the camera passes between the letters into space — type is the portal.

Pinned vs free: nothing is CSS-pinned; the canvas is fixed and every scene is scroll-scrubbed. Free-scrolling DOM stretches: hero, reel copy, featured grid, goal intro, footer (≈ 10 viewports). Scrubbed/held stretches: PLAY REEL (≈1.5 vp), the whole goal journey (≈43 vp), the CTA (3.5 vp, the title stays centred while stickers drift).

### 1.2 Type
Family **Aeonik, weight 400 everywhere** (the only 500s are 14 px uppercase UI labels). Distinct sizes seen on the home page at 1440: 144 · 115.2 · 108 · 86.4 · 50.4 · 48.6 · 43.2 · 38 · 36 · 26 · 21.6 · 18 · 14.4 · 14 · 12.96 · 11.88 → **16 distinct sizes, largest:smallest = 12.1:1**; display:body (144:21.6) = **6.7:1**. Display tracking −2 % (−2.88 px at 144), line-height 1.0 on display (115 px pitch at 115 px; 158 px pitch at 144 px with a two-line stack), 1.4 on body (30 px at 21.6). Small labels are uppercase, 12.96–14.4 px, tracked.
At 390: 78 · 76 · 62.4 · 58.5 · 50.7 · 49 · 47.25 · 26 · 25.35 · 23.4 · 17.5 · 16.8 · 16 · 15.75 · 14 · 13.65 · 11.55 · 9.75 → 18 sizes, ratio 8:1. Display 144 → 78 (×0.54) while the viewport is ×0.27 wide, i.e. display ≈ 10 vw desktop / 20 vw phone: type scales with roughly the square root of width, so it stays huge on phones.
Project page: description 12 px, services list 12 px, "Launch project" 14 px, next-project title 72 px.

### 1.3 Grid, margins, header
- Outer margin **72 px each side at 1440 (5 %, content 1,296)**; **15 px at 390** (content 360). Lusion works on a 2-column rhythm inside that (634 + 28 gutter + 634); the body paragraph in the reel starts at x = 734, i.e. exactly the right half. Display type always starts at the left margin (x 64–72, optical overhang of 4–8 px).
- Header: fixed, transparent, 146 px tall touch zone; logo 120×27 at (72, 59); right cluster at y 50: sound (45 px circle), "Let's talk" pill 134×45 (dark #2b2e3a), "Menu" pill 102×45 (light #e4e6ef), labels 14 px/500 uppercase, each pill with a 4 px dot. On the dark journey the header inverts to white. Phone: header inset 15 px, 46 px tall.
- Menu: **not a takeover.** A right-anchored white card column 310×613 at (1058, 108): links block 310×264 with four 26 px links on a 58 px pitch; hover rolls the word up 26 px while a clone rolls in from below, and a blue (rgb 0,22,236) pill behind it fades to 10 % opacity; then a newsletter block (38 px title, 250×70 input) and a black "Labs" block 310×78. The button's label itself rolls "Menu" → "Close".

### 1.4 How work is presented
- 12 cards, **2 columns × 6 rows**, each **634×502**: image area 634×412 (1.54:1, 15 px radius) + 71 px footer = one 12.96 px uppercase tag line ("concept • web • design • 3d") and the **43.2 px title**. Column gutter 28 px, row gap 80 px. Section heading "Featured Work" 115 px flush-left; a 12.96 px uppercase intro top-right. "See all projects" pill 190×49 centred at the bottom.
- The thumbnails are **not DOM media** — no `<img>/<video>` exist; the card images are rendered on the one WebGL canvas behind the DOM holes, which is what lets them bend, swap and keep one clock.
- Hover: each title letter is a column of stacked glyphs that translates −794 px (a vertical roll), an arrow icon slides in 43 px from the left of the title, the row of letters shifts right 65 px to make room. ≈ 0.4 s. No scale, no shadow, no colour change on the image.
- Phone: 1 column, 360×295 cards, 32 px row gap, 9.75 px tags, 25 px titles.
- Project page: a **single pinned viewport (900 px tall)** that scrolls horizontally: description (12 px) and services list ride left (x −61 → −728 over 3,000 px of wheel), a device-mockup hero in 3D, "scroll to explore" bottom-right, a 72 px "Next project" title waiting at the far right.

### 1.5 How 3D and type share the frame (focal points)
- Hero: headline occupies the top 18 % (y 46–166) in a right-of-centre column (x 403–922); the 3D object's visual centre sits at ≈ (720, 560) = centre, lower-middle. Two zones, no overlap.
- Reel: display type in the upper-left quadrant (x 68–958, y 81–384), body copy in the right half (x 734+), the 3D ribbon enters top-left and crosses behind the type toward the centre — a diagonal leading line into the paragraph.
- Goal intro: type owns the left 75 % (1,081 px wide, 3 lines, y 185–531 = the middle third); the cyan ring sits behind the type's first line top-left; a tablet product shot bottom-left; a 16 px paragraph bottom-right. Type leads, 3D is background texture here.
- Journey headline: type is justified across the full width in three uppercase lines on the middle third; the astronaut floats **between** the words (x ≈ 840–940) — type and star interleave once, right before the fly-through.
- CTA: type dead-centre (x 393–1047, y 273–702), the astronaut directly under it, stickers at the frame edges.
Pattern: Lusion alternates **type-left / object-right-or-behind** with **object-centre / type-above-or-below**; it never puts both at the same point except the one interleave that becomes the transition. The reference frame is the second pattern, done with far more air (object upper 60 %, type lower third) — that is the frame grammar we adopt.

### 1.6 Transitions
- Light → dark happens once (goal intro → journey) and is carried by the fly-through-type move; dark → light happens once (CTA → footer) as a plain cut on scroll.
- Between light sections there are no wipes or curtains: elements simply enter with a mask slide-up (title lines) and the 3D object keeps moving on its own clock, so the canvas is the continuity.
- The 3D canvas is one scene graph; objects hand over by camera motion, not by section boundaries.
- End of page: an over-scroll "bar" on the right edge fills, then the next page loads (observed, §1.1 row 7).

### 1.7 Phone 390×844
Total 47,411 px = **56 viewports**; same 7 sections: hero 1.0 · reel 1.6 · featured 5.2 · goal 43.6 · end 3.5 · footer 1.0 · nav 0.3. The dark journey is the same length on the phone — the structure does not change, only the grid collapses to one column and the type drops to ≈ 20 vw. The hero on phone stacks: logo, "Scroll to explore", a 78 px three-line display, 16 px paragraph, pill, the 3D object in a tall card below.

---

## 2 · Distilled principles (abstract; what to learn, not what to copy)

1. **One page, one surface.** A single always-on 3D canvas under a transform-scrolled DOM; sections are chapters of one scene, and the camera (not section edges) carries you between them.
2. **Short page, long cinema.** Front-load the readable page (≈8 viewports), then spend the bulk of the scroll on one scrubbed sequence with one star; close fast (≈4 viewports). Calm:peak by length ≈ 1:5 — too long for us; see §3 for our ratio.
3. **Earn the dark.** Change the field colour exactly once each way, and make each change a *move* (through type, through a surface), never a fade.
4. **Type is scenery.** Display type is treated as a 3D-scale object: 10 vw on desktop, 20 vw on phone, weight 400, line-height 1.0, negative tracking — it earns its place by size and placement, never by weight or colour.
5. **Few sizes, one weight, big jumps.** Hierarchy comes from a ≥ 6:1 display:body jump and a ≥ 12:1 display:caption jump, all in one weight; small text is uppercase, tracked, 12–14 px.
6. **Two zones per frame.** Type and the 3D star never compete for one point: left-third/right-two-thirds, or centre-object/lower-type. Allow the two to interleave only once, and let that moment become the transition.
7. **Give the star the whole frame when it speaks.** For the long passages the copy disappears entirely; the viewer reads the scene. Copy returns only at beats.
8. **Scrub, don't autoplay.** All long motion is scroll-scrubbed with a damped scroller; the only time-based moments are the loader and the hover micro-rolls.
9. **Hover is a roll, never a lift.** Interactive text rolls vertically (glyph columns), an icon slides in; images never scale, lift or gain shadows.
10. **Media lives in the scene.** Work thumbnails render in the canvas behind DOM "holes" so they can bend, swap and share the single clock; the DOM supplies layout and accessibility.
11. **A grid with air.** 5 % outer margins, a strict 2-column rhythm for text vs. media at desktop, 1 column at phone; the display line always starts at the margin.
12. **The nav is furniture, not a scene.** Fixed, transparent, two pills and a logo; the menu is a compact card, with roll-overs — it never interrupts the canvas.
13. **End on one ask.** The CTA is a single centred line plus the star beneath it, held for 3–4 viewports, then a short footer — and the page hands off (over-scroll) instead of dead-ending.
14. **Same bones on every device.** Phone keeps every section and the same ratios; only columns collapse and type scales with ≈√width so it still feels enormous.
15. **Loader as the first beat.** The count-to-100 is a real progress read and the first motion the viewer sees; the hero inherits its momentum.

---

## 3 · Applying the principles to OUR story (reference frame grammar wins)

Grid: **12 columns**, outer margin `max(20px, 5vw)` (72 px at 1440, 20 px at 390), gutter 24 px, column ≈ 86 px at 1440. Rows: an 8-pt baseline; display line-height 1.0; body 1.45; small 1.4. Type: Inter Regular only — **display `clamp(96px, 14vw, 240px)`** (202 px at 1440, 96 px at 390), **body ≈ 19 px**, **small 12.5 px** → display:body 10.6:1, display:small 16:1 (bigger contrast than Lusion's 6.7 / 12). No borders, no shadows, no cards, UI black/white/grey; colour lives only in the 3D.

**The reference frame, as a reusable template ("R-frame"):**
- Field: off-white (#f3f3f1-ish; black field only in the dive/journey).
- Star: one vibrant 3D object, centred on cols 4–9 (x 25–75 %), its bounding box inside y 8–60 %, visual centre at ≈ y 36 %.
- Display: two lines, flush-left, cols 1–10, baseline of line 2 at y ≈ 88 %.
- Caption: small size, two lines, right-aligned, cols 11–12, last baseline **on** the display's last baseline.
- Nothing else in the frame. Nav is our only exception (logo top-left, one pill top-right).

| # | Principle | Lusion evidence | Our section & how we apply it (12-col) |
|---|---|---|---|
| 1 | One surface | fixed canvas + transform scroller | Already ours (Lenis + one R3F canvas + one GSAP clock). Sections only move the camera; no section backgrounds except the two field changes. |
| 2 | Short page, long cinema | 8 vp page / 44 vp cinema / 4.5 vp end | Our lengths (desktop, in viewport heights): **Intro** time-based (0 scroll) · **Hero** 250 vh (pinned 100, crane 150) · **Statement** 300 vh (pinned, 3 phrases × 100) · **Lab** 450 vh (pinned shelf, 7 reels ≈ 60 vh each + 30 vh entry) · **Systems** 150 vh (free) · **Dive** 400 vh (pinned scrub) · **Journey** 1,000 vh (pinned, 3 beats: space 350, forest 300, tablet reveal + break 350) · **Contact** 150 vh + over-scroll. Total ≈ 2,700 vh ≈ 27 viewports (Lusion 57). Calm (hero, statement, systems, contact) ≈ 8.5 vp; semi-calm lab 4.5; cinema (dive + journey) 14 vp → calm:peak ≈ 1:1.6. **Deliberately shorter than Lusion:** his 31 wordless viewports is the one thing not to scale up. |
| 3 | Earn the dark | one light→dark via fly-through type | Light field from Intro to Systems. **Systems → Dive** is our one light→dark: flipping the toggle dims, the water surface tilts up and the camera breaks the surface (a move through a surface, like their move through type). **Journey → Contact** is the one dark→light: the crewmate's break-out droplets land on bright water. No other field changes. |
| 4 | Type is scenery | 144 px, lh 1.0, −2 % tracking, 400 | Display at 14 vw, Inter Regular, line-height 1.0, letter-spacing −0.02em; display never exceeds two lines; it always starts at col 1. |
| 5 | Few sizes, big jumps | 16 sizes, 12:1 | **3 sizes only**: display / 19 / 12.5. Every label, tag, year, tool name and nav word is 12.5 px uppercase tracked +0.06em; every sentence is 19 px; everything else is display. |
| 6 | Two zones per frame | type-left / object-right; type-centre / object-under | **R-frame everywhere a frame holds still:** Hero = diamond centred upper 60 %, "Shifat Masud" two-line display lower third cols 1–10 (line 1 "Shifat", line 2 "Masud"), caption "Design engineer & creative technologist / Dhaka" cols 11–12 bottom-right baseline-aligned. Statement = the water (star) fills the upper 60 % top-down, one display phrase lower third, its specific line as the caption. Systems = toggle puck centred upper 60 %, display "Feels like / a system" lower third, caption names Shade DS. Contact = button centred upper 60 % (it is the star), display "Say hi" lower third, live Dhaka time as the caption. This replaces the story's earlier "right-third diamond / left-column name" note: reference wins. |
| 7 | Give the star the frame | ≈31 vp with no copy | Dive and Journey carry **no body copy at all** — only two 12.5 px cue lines in the Journey (one in space, one at the reveal), bottom-right cols 11–12, and the tool names in the Dive as 12.5 px labels. Display "Under the surface" appears once at the dive entry and sinks. |
| 8 | Scrub, don't autoplay | all scrubbed | Hero crane, statement phrases, lab shelf, dive camera, journey beats: all driven from scroll progress through the spring-damped camera (already f 0.9, ζ 1). Time-based: the intro counter/drop, the diamond's tip-kiss ring, water, hover rolls. |
| 9 | Hover is a roll | glyph column roll, arrow slide, no lift | Lab titles roll vertically on hover/focus (our own glyph-stack build), Contact button text rolls; **no scale, no shadow, no border** anywhere. Colour change is allowed only in the 3D (reel grey → colour), never on UI. |
| 10 | Media in the scene | canvas-rendered thumbs behind DOM holes | Our reels already live in the water via three-html-render; keep the DOM title/tags as real text at 19 / 12.5 px under each reel, left-aligned to the reel's left edge. |
| 11 | Grid with air | 5 % margins, 2-col rhythm | 12 cols, 5 vw margins. Text blocks never exceed cols 1–6 (≈ 50 %) for 19 px copy; the reference's lower-third display may run to col 10. Phone: 20 px margins, display 96 px (≈ 25 vw), caption moves below the display, left-aligned, still baseline-stacked. |
| 12 | Nav is furniture | logo + two pills, compact card menu | Ours: logo/name top-left (12.5 px), ONE pill top-right ("Say hi" → scrolls to contact); no menu for a single page. A 12.5 px section index (01–07) on the right edge at mid-height is optional and must stay grey. Pill: no border, no shadow — a filled black pill on light, white on dark. |
| 13 | End on one ask | centred CTA held 3.5 vp, short footer, hand-off | Contact uses the R-frame with the button as the star, held 150 vh; footer is **one line** (links as 12.5 px, © and local time) under the display baseline — no columns, no newsletter. Over-scroll fills the right-edge water level and floats back to the hero (our own hand-off; no page navigation). |
| 14 | Same bones on phone | 56 vp, same sections | Phone keeps all 8 sections; display 96 px / two lines; the star's box becomes y 8–55 % to leave room for the stacked caption; pinned lengths shrink ≈ 30 % (hero 200, statement 240, lab 360, dive 300, journey 700) because thumb-scrolling is faster. |
| 15 | Loader as first beat | count to 100 bottom-left in a mark | Keep the honest 000→100 counter but render it as the display size in the R-frame's lower-third slot (cols 1–10) so the hero's display type inherits its exact position — the number becomes the name. The drop falls from the star's position. No logo mark, no mask. |

**Where the 3D star and type split the frame, per section (desktop):**

| Section | Star (3D) | Display | Caption / small | Pinned? | Length |
|---|---|---|---|---|---|
| 0 Intro | drop, from centre y 36 % | counter, cols 1–10 lower third | — | time-based | — |
| 1 Hero | diamond on the lake, centre, y 8–60 % | "Shifat / Masud" cols 1–10 | title + Dhaka, cols 11–12 | pinned 100 vh then crane | 250 vh |
| 2 Statement | water top-down + the ring, upper 60 % | one phrase at a time, cols 1–10 | its specific line, cols 11–12 | pinned | 300 vh |
| 3 Lab | the centred reel (in colour), cols 4–9, y 15–60 % | "Lab" once at entry, then none | title 19 px + tags 12.5 px under each reel | pinned horizontal shelf | 450 vh |
| 4 Systems | toggle puck centre upper 60 %, other pucks at the edges, greyer | "Feels like / a system" | Shade DS / MCP / Upsy line, cols 11–12 | free | 150 vh |
| 5 Dive | Snell's window top-centre, god rays down the frame | "Under the surface" once, sinks | tool names 12.5 px at depths, cols 2–4 and 9–11 | pinned scrub | 400 vh |
| 6 Journey | crewmate, always centre-weighted (thirds: left third in space, centre in forest, centre at the break) | none | two 12.5 px cue lines, cols 11–12 | pinned scrub | 1,000 vh |
| 7 Contact | the button (largest target), centre upper 60 % | "Say hi" cols 1–10 | Dhaka time + links as one 12.5 px line | pinned | 150 vh + overscroll |

---

## 4 · Do-not-clone list (Lusion layouts and devices we must not reproduce one-to-one)

1. The hero's **dark rounded "frame within the frame"** holding a 3D object with the headline above it (and the L-shaped loader mark with the counter inside it). Our intro counter sits bare on the field; our hero is the open R-frame.
2. The **"Bold Ideas, Brought to Life" layout**: display upper-left + paragraph in the right half + a diagonal 3D ribbon crossing behind. We never put a body paragraph beside display type; our display sits in the lower third.
3. The **"PLAY REEL" uppercase marquee** strip and its 1.5-viewport hold over a video.
4. The **2 × 6 card grid of 634×502 rounded thumbnails with 12.96 px tag + 43 px title, rolling-letter titles with a sliding arrow, "See all projects" pill**. Ours is a horizontal shelf of reels in the water, one in colour at a time, title/tags under each; no grid, no radius-card, no arrow slide.
5. The **"Where Creative Ideas…" statement with a cyan ring and a tablet product shot**. Our tablet appears only inside the Journey as a story reveal (the camera pulls back to find the forest was on a screen) and is never a product-shot hero; keep its proportions generic and the scene lit as a room, not a mockup.
6. The **justified full-width uppercase headline with the astronaut between the words, then flying through the letters** into space. Our light→dark move is through the *water surface*; type never becomes a portal.
7. The **astronaut deep-space drift as the long act** (≈31 viewports, white suit, black void, planet/stars). Ours is a red crewmate with three beats (space → forest → tablet break-out), 10 viewports, colourful space, and the forest/tablet beats do not exist in Lusion; keep the space beat short (≤ 350 vh) so the resemblance stays at the level of "a figure in space".
8. The **"Let's work together!" centred white-on-black CTA with sticker/toy 3D props** and the "continue to scroll" pill. Our contact is on bright water with the button as the star.
9. The **four-column footer with a newsletter title and input**, and the **over-scroll-to-next-page** hand-off. Ours: one footer line; over-scroll floats back to the hero.
10. The **header**: sound toggle + "Let's talk" dark pill + "Menu" light pill with dots; the **drop-down menu card** with blue roll-over pills, newsletter and Labs blocks. Ours: name + one pill, no menu.
11. The **project page** (pinned horizontal scroller around a device mockup with "scroll to explore" and a waiting "Next project"). We have no project pages; the shelf is the work.
12. Any **Aeonik-like geometric sans, the cyan/blue brand ribbon, the jacks, the astronaut model, the stickers, the "L" mark, the copy** ("Bold Ideas…", "Step into a new world…", "Let's work together!") — none of it, in any form.

What we DO take: the one-surface scroller, the short-page/long-cinema rhythm (at our 1:1.6 ratio), one weight + big size jumps (pushed further to 3 sizes), two-zone framing (replaced by the reference's R-frame), copy-less cinema with cue lines, scrubbed camera, roll-over hovers without lift, media rendered in the scene, 5 % margins, one ask at the end, same bones on phone, loader as first beat.

---

## 5 · Unverified / limits of this read
- Hover and roll timings (~0.4 s) are estimated from two frames 900 ms apart, not from a timeline read.
- The 3D focal positions are read from screenshots at 1440×900 and may shift with their responsive camera.
- Scroll lengths were read from the DOM at the two viewports named; other widths were not measured.
- The journey's internal beat boundaries (where the astronaut lands, the planet, etc.) were not timestamped — the canvas has no DOM markers and the remote browser rendered that stretch slowly; what is certain is the ≈31-viewport copy-free span between y ≈ 18 k and 46 k.
