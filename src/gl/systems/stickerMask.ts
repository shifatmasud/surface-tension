/** W23 (scorer-r621 #3: a hover across the Figma sticker dragged a white wedge off its edge): where the CTA stickers sit
 *  on screen (viewport px: centre x, y, face radius, on), written by journey/stickerInteract.ts and read by the trail's
 *  distortion pass (post/PostChain.ts), which leaves them alone. Its own tiny module so the boot chunk does not pull in
 *  the journey stage. */
export const stickerMask = { on: 0, c: new Float32Array(16) }

/** W23 (scorer-r6261 #1: at 390 a touch sweep left a grey hook just outside the stone's right edge): where the hero stone
 *  sits on screen (viewport px: centre x, y, radius; on), written by hero/HeroStage.tsx, so the trail's smear does not
 *  drag the stone's edge out across the water */
export const gemMask = { on: 0, x: 0, y: 0, r: 0 }
