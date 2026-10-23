/**
 * R6.92b GIFT STICKER IN THE TRAIL (Shifat Oct 23 9:43 AM: "Cursor trail should refract the gift sticker too").
 * The sticker stays a DOM button (hit-testing, tap, drag, peel, keyboard) drawing itself into its own 2D canvas
 * (dom/gift/giftSticker.ts). That canvas is shared here; the hero pass (post/heroPass.ts) draws it over the finished
 * frame at the canvas density, through the same locked 9-tap trail smear and wake fringe as the other refracted
 * content, placed from the button's live rect and its CSS transform (rotation, scale). While the GL copy draws, the DOM
 * canvas is transparent (html.stk-gl); the static page (no-gl) keeps the DOM canvas.
 */
export const stickerGL = {
  cv: null as HTMLCanvasElement | null,   // the sticker's canvas (css size W x W, centred on the button)
  el: null as HTMLElement | null,         // the button (its rect centre = the canvas centre, transform included)
  W: 0,                                   // the canvas's css size
  rot: 0, sc: 1,                          // the button's CSS rotate (rad) and scale
  dirty: false,                           // the canvas changed since the last upload
}
