import { Component, lazy, Suspense, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Analytics } from '@vercel/analytics/react'
import { Header } from './dom/ui/Header'
import { Cursor } from './dom/ui/Cursor'
import { Intro } from './dom/ui/Intro'
import { WaterLevel } from './dom/ui/WaterLevel'
import { ProjectOverlay } from './dom/ui/ProjectOverlay'
import { TextLayer } from './dom/ui/TextLayer'
import { Hero } from './dom/sections/Hero'
import { Lab } from './dom/sections/Lab'
import { Systems } from './dom/sections/Systems'
import { Dive } from './dom/sections/Dive'
import { Journey } from './dom/sections/Journey'
import { Contact, Footer } from './dom/sections/Contact'
import { settings } from './services/settings'

/** R6.92: a WebGL context the browser refuses (Chrome after repeated GPU resets: "GL_VENDOR = Disabled", "Could not create a
 *  WebGL context") must not take the page down with it. The scene's failure is caught here and the page reloads once on the
 *  designed static path (st-gl-dead for this session; services/settings.ts reads it as tier 'none'). */
class SceneGuard extends Component<{ children: ReactNode }, { dead: boolean }> {
  state = { dead: false }
  static getDerivedStateFromError() { return { dead: true } }
  componentDidCatch(e: unknown) {
    console.warn('[surface-tension] WebGL unavailable, static page:', (e as Error)?.message || e)
    document.documentElement.classList.add('no-gl')
    try { if (!sessionStorage.getItem('st-gl-dead')) { sessionStorage.setItem('st-gl-dead', '1'); location.reload() } } catch { /* private mode */ }
  }
  render() { return this.state.dead ? null : this.props.children }
}

const Scene = lazy(() => import('./gl/Scene').then((m) => ({ default: m.Scene })))

/** R6.76 LOAD PATH: `lite` is the first, urgent commit on the WebGL path: the skip link and the preloader alone (it adopts the
 *  shell counter and starts its clock at once); the full page then renders as a transition in short slices behind the
 *  opaque preloader. Every element keeps its place in the tree, so the preloader is not remounted by the full render. */
export function App({ lite = false }: { lite?: boolean }) {
  const canvasHost = document.getElementById('canvas')!
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      {!lite && settings.USE_GL && createPortal(<SceneGuard><Suspense fallback={null}><Scene /></Suspense></SceneGuard>, canvasHost)}
      <Intro />
      {!lite && <Header />}
      {!lite && <Cursor />}
      {!lite && <WaterLevel />}
      {!lite && <TextLayer />}
      {!lite && (
        <main id="main" tabIndex={-1}>
          <Hero />
          <Dive />
          <Lab />
          <Systems />
          <Journey />
          <Contact />
        </main>
      )}
      {!lite && <Footer />}
      {!lite && <ProjectOverlay />}
      {!lite && settings.GRID && <div className="grid-debug" aria-hidden>{Array.from({ length: 12 }, (_, i) => <i key={i} />)}</div>}
      <Analytics />
    </>
  )
}
