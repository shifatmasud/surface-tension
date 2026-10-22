import './styles/app.css'
import { startTransition } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { boot } from './app/boot'
import { settings } from './services/settings'
import { initPress } from './services/press'

// preRun: brand font first, then build everything (ch.2 / ch.9.1)
boot.preRun().then(() => {
  boot.run()
  initPress()
  // R6.76 LOAD PATH: the first mount renders as a transition, so React builds the DOM in ~5 ms slices between frames
  // (the shell odometer keeps rolling) instead of one long task; the committed DOM is the same
  // On the WebGL path the preloader commits first on its own (urgent, tiny), so its counter and its clock start as early as
  // before; the page behind it follows as the transition. The static page (no GL) has its hero painted by the shell, so it
  // takes the transition alone (no frame without the hero).
  const root = createRoot(document.getElementById('root')!)
  if (settings.USE_GL) root.render(<App lite />)
  startTransition(() => root.render(<App />))
  boot.phase = 'init'
  if (settings.DEBUG) console.info('[surface-tension] settings', settings)
})
