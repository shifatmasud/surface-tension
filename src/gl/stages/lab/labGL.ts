/** Lab GL controller (filled in by the lab stage). */
export const labGL = {
  offsetX: 0,
  track: null as HTMLElement | null,
  mount(el: HTMLElement) { this.track = el },
  unmount() { this.track = null },
  measure() {},
  hover(_id: string, _on: boolean) {},
}
