import { lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
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

const Scene = lazy(() => import('./gl/Scene').then((m) => ({ default: m.Scene })))

export function App() {
  const canvasHost = document.getElementById('canvas')!
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      {settings.USE_GL && createPortal(<Suspense fallback={null}><Scene /></Suspense>, canvasHost)}
      <Intro />
      <Header />
      <Cursor />
      <WaterLevel />
      <TextLayer />
      <main id="main" tabIndex={-1}>
        <Hero />
        <Dive />
        <Lab />
        <Systems />
        <Journey />
        <Contact />
      </main>
      <Footer />
      <ProjectOverlay />
      {settings.GRID && <div className="grid-debug" aria-hidden>{Array.from({ length: 12 }, (_, i) => <i key={i} />)}</div>}
    </>
  )
}
