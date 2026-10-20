/**
 * W18-DIVE OVER-UNDER (Shifat 15:29Z + 15:30Z): the one waterline edge shared by every layer that is cut by it, so the
 * underwater half (dive materials: shaders.ts CLIP), the lake above it (water.ts) and the post meniscus (effects.ts
 * GradeEffect) all agree on where the line is, to the pixel. x = screen x in units of the screen height, t = seconds.
 * Returns the edge's offset in units of the screen height.
 */
export const WL_EDGE = /* glsl */ `
float wlEdge(float x, float t){
  return 0.010 * sin(x * 7.0 + t * 1.3) + 0.006 * sin(x * 17.0 - t * 2.1) + 0.003 * sin(x * 41.0 + t * 3.0);
}
`
