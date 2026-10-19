// All copy is ours. Facts from Shifat's public GitHub (read 19 Oct 2026). Unverified items are marked.
export const SITE = {
  name: 'Shifat Masud',
  role: 'Design engineer & creative technologist',
  city: 'Dhaka',
  tz: 'Asia/Dhaka',
  github: 'https://github.com/shifatmasud',
  x: 'https://x.com/shifatmasud',
  // No public email was verifiable; set one here and the contact button switches to mailto.
  email: '' as string,
  publicRepos: 118, // GitHub API, 19 Oct 2026
}
export const STATEMENT = [
  ['I design systems', 'that feel ', ['physical'], '.'],
  ['Interfaces with weight.', 'Water with ', ['logic'], '.'],
  ['Built in code,', 'tuned by hand.'],
]
export type Project = { id: string; no: string; title: string; year: string; tags: string[]; blurb: string; url: string; media: string; poster: string; client?: string }
export const PROJECTS: Project[] = [
  { id: 'water', no: '01', title: 'Water Sim', year: '2025', tags: ['WebGL', 'GPGPU', 'R3F'], blurb: 'A real-time water surface you can stir — heightfield sim, caustics and refraction in the browser.', url: 'https://water-scene.vercel.app', media: 'media/water-sim.mp4', poster: 'media/water-sim.webp' },
  { id: 'jelly', no: '02', title: 'Jelly Drag', year: '2025', tags: ['Physics', 'Shaders'], blurb: 'Soft-body UI that squashes, wobbles and settles like the real thing.', url: 'https://jelly-drag.vercel.app', media: 'media/jelly-drag.mp4', poster: 'media/jelly-drag.webp' },
  { id: 'fluid', no: '03', title: 'Fluid Matter', year: '2025', tags: ['Fluid sim', 'WebGL'], blurb: 'Stable-fluids painting with matter that keeps its momentum.', url: 'https://fluid-matter-physics.vercel.app', media: 'media/fluid-matter.mp4', poster: 'media/fluid-matter.webp' },
  { id: 'geo', no: '04', title: 'Geo-Slash', year: '2025', tags: ['React 18', 'MediaPipe', 'Game'], blurb: 'A hand-tracked slicing game: your webcam is the controller.', url: 'https://geo-slash.vercel.app', media: 'media/geo-slash.mp4', poster: 'media/geo-slash.webp' },
  { id: 'audio', no: '05', title: 'Audio Viz', year: '2025', tags: ['Web Audio', 'GLSL'], blurb: 'An NCS-style visualiser driven by FFT bands and beat detection.', url: 'https://ncs-style-audio-viz.vercel.app', media: 'media/audio-viz.mp4', poster: 'media/audio-viz.webp' },
  { id: 'tank', no: '06', title: 'ArcadeGPU Tank', year: '2025', tags: ['GPU', 'Game', 'Client'], blurb: 'A GPU-driven arcade tank demo built for a client engine.', url: 'https://arcade-gpu-tank-demo-beta.vercel.app', media: 'media/arcade-tank.mp4', poster: 'media/arcade-tank.webp', client: 'Client work' },
]
export const TOOLS = ['React', 'R3F', 'GLSL', 'GSAP', 'Framer Motion', 'TSL / WebGPU', 'Figma', 'TypeScript']
