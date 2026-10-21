/** W23 (scorer-r621 #3: a hover across the Figma sticker dragged a white wedge off its edge): where the CTA stickers sit
 *  on screen (viewport px: centre x, y, face radius, on), written by journey/stickerInteract.ts and read by the trail's
 *  distortion pass (post/PostChain.ts), which leaves them alone. Its own tiny module so the boot chunk does not pull in
 *  the journey stage. */
export const stickerMask = { on: 0, c: new Float32Array(16) }
