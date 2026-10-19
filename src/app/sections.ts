import { DomRange } from '../services/scroll'
/**
 * Section lifecycle (ch.6.4): every section implements preInit / init / resize / update / show / hide.
 * Sections are singletons registered here and ticked by the one clock in a fixed order.
 */
export interface Section {
  name: string
  range?: DomRange
  preInit?(): void
  init?(): void
  resize?(): void
  update?(dt: number): void
  show?(): void
  hide?(): void
  _shown?: boolean
}
class SectionManager {
  list: Section[] = []
  add(s: Section) { this.list.push(s); s.preInit?.(); s.init?.(); return () => { this.list = this.list.filter((x) => x !== s) } }
  resize() { for (const s of this.list) { s.range?.measure(); s.resize?.() } }
  update(dt: number) {
    for (const s of this.list) {
      if (s.range) {
        s.range.update()
        if (s.range.isActive && !s._shown) { s._shown = true; s.show?.() }
        else if (!s.range.isActive && s._shown) { s._shown = false; s.hide?.() }
      }
      s.update?.(dt)
    }
  }
}
export const sections = new SectionManager()
