// All copy is ours. Facts from Shifat's public GitHub (read 19 Oct 2026). Unverified items are marked.
export const SITE = {
  name: 'Shifat Masud',
  role: 'Design engineer & creative technologist',
  github: 'https://github.com/shifatmasud',
  x: 'https://x.com/shifatmasud',
  // No public email was verifiable; set one here and the contact button switches to mailto.
  email: '' as string,
  publicRepos: 118, // GitHub API, 19 Oct 2026
}
/** SECTION CUT (Shifat 15:41Z): the Statement section is gone; its line plays in the global text slot during the dive's
 *  descent (dom/ui/TextLayer.tsx). Kept as data so the copy lives in one place. */
export const PHRASES = [
  { t: ['Pixels', 'with mass.'], c: 'Springs, buoyancy and damping, written by hand, so an interface pushes back when you touch it.' },
]
export type Project = { id: string; role: string; no: string; title: string; year: string; tags: string[]; blurb: string; url: string; media: string; poster: string; depth?: string; color: boolean; client?: string }
// Serial position: the strongest, most on-theme piece first, the most tactile last.
// SECTION CUT (Shifat 15:41Z): the Lab is no longer its own chapter; its best three pieces are the dive's work slides.
export const PROJECTS: Project[] = [
  { id: 'water', role: 'Design & GPU simulation', no: '01', title: 'Water Sim', year: '2025', tags: ['WebGL', 'GPGPU', 'R3F'], blurb: 'A height-field you can stir, with refraction and caustics, running in a browser tab.', url: 'https://hybrid-water-sim.vercel.app', media: 'media/water-sim-color.mp4', poster: 'media/water-sim-color.webp', depth: 'media/water-sim-depth.webp', color: true },
  { id: 'geo', role: 'Design & game dev', no: '02', title: 'Geo-Slash', year: '2025', tags: ['MediaPipe', 'Game'], blurb: 'A slicing game where your webcam is the controller: hand tracking in real time.', url: 'https://geo-slash.vercel.app', media: 'media/geo-slash-color.mp4', poster: 'media/geo-slash-color.webp', depth: 'media/geo-slash-depth.webp', color: true },
  { id: 'jelly', role: 'Design & interaction', no: '03', title: 'Jelly Drag', year: '2025', tags: ['Soft body', 'Shaders'], blurb: 'Soft-body UI: drag it and it squashes, overshoots and settles like the real thing.', url: 'https://jelly-drag.vercel.app', media: 'media/jelly-drag-color.mp4', poster: 'media/jelly-drag-color.webp', depth: 'media/jelly-drag-depth.webp', color: true },
]
export const TOOLS = ['React', 'R3F', 'GLSL', 'GSAP', 'Framer Motion', 'TSL / WebGPU', 'Figma', 'TypeScript']
