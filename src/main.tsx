import './styles/app.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { boot } from './app/boot'
import { settings } from './services/settings'
import { initPress } from './services/press'

// preRun: brand font first, then build everything (ch.2 / ch.9.1)
boot.preRun().then(() => {
  boot.run()
  initPress()
  createRoot(document.getElementById('root')!).render(<App />)
  boot.phase = 'init'
  if (settings.DEBUG) console.info('[surface-tension] settings', settings)
})
