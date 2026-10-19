import { lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { Header } from './dom/ui/Header'
import { Cursor } from './dom/ui/Cursor'
import { Intro } from './dom/ui/Intro'
import { WaterLevel } from './dom/ui/WaterLevel'
import { ProjectOverlay } from './dom/ui/ProjectOverlay'
import { Hero } from './dom/sections/Hero'
import { Statement } from './dom/sections/Statement'
import { Lab } from './dom/sections/Lab'
import { Systems } from './dom/sections/Systems'
import { Dive } from './dom/sections/Dive'
import { Journey } from './dom/sections/Journey'
import { Contact } from './dom/sections/Contact'
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
      <main id="main" tabIndex={-1}>
        <Hero />
        <Statement />
        <Lab />
        <Systems />
        <Dive />
        <Journey />
        <Contact />
      </main>
      <ProjectOverlay />
      {settings.GRID && <div className="grid-debug" aria-hidden>{Array.from({ length: 12 }, (_, i) => <i key={i} />)}</div>}
    </>
  )
}
