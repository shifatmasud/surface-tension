/**
 * W18-DIVE OVER-UNDER (Shifat 15:29Z + 15:30Z): the one waterline edge shared by every layer that is cut by it, so the
 * underwater half (dive materials: shaders.ts CLIP), the lake above it (water.ts) and the post meniscus (effects.ts
 * GradeEffect) all agree on where the line is, to the pixel. x = screen x in units of the screen height, t = seconds.
 * Returns the edge's offset in units of the screen height.
 */
/** R7.12 b8-water-v1: ?wsplit=old = the R7.11 over-under split (A/B) */
export const WS_OLD = typeof location !== 'undefined' && /[?&]wsplit=old\b/.test(location.search)
export const WL_EDGE = /* glsl */ `
float wlEdge(float x, float t){
  return 0.010 * sin(x * 7.0 + t * 1.3) + 0.006 * sin(x * 17.0 - t * 2.1) + 0.003 * sin(x * 41.0 + t * 3.0);
}
/** R7.12 b8-water-v1 (Shifat: "air water split scene … better quality", real over-under refs): the over-under line itself.
 *  A dome-port waterline in the refs is one near-level line with a gentle swell, not a rope: half the amplitude, a longer
 *  swell and almost none of the fine ripple. Every layer cut by the lens line (lake, water world, gem sheen, the grade's
 *  meniscus) calls this, so they still agree to the pixel. wlEdge above is untouched (the footer curtain uses it).
 *  ?wsplit=old = the R7.11 edge. */
float wlEdgeS(float x, float t){
  return ${WS_OLD ? 'wlEdge(x, t)' : '0.0055 * sin(x * 5.0 + t * 0.9) + 0.0025 * sin(x * 13.0 - t * 1.6) + 0.0008 * sin(x * 37.0 + t * 2.6)'};
}
`

/** R7.12 b8-water-v2: JS twins of wlEdge / wlEdgeS above (keep in step). HeroStage uses them to move the stone sheen's own
 *  meniscus cut (gemSheen.ts, locked: it still calls wlEdge) onto the over-under line at the stone's screen x, per draw. */
export function wlEdgeJ(x: number, t: number): number {
  return 0.010 * Math.sin(x * 7.0 + t * 1.3) + 0.006 * Math.sin(x * 17.0 - t * 2.1) + 0.003 * Math.sin(x * 41.0 + t * 3.0)
}
export function wlEdgeSJ(x: number, t: number): number {
  return WS_OLD ? wlEdgeJ(x, t) : 0.0055 * Math.sin(x * 5.0 + t * 0.9) + 0.0025 * Math.sin(x * 13.0 - t * 1.6) + 0.0008 * Math.sin(x * 37.0 + t * 2.6)
}
