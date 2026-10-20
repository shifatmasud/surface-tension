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
export type Project = { id: string; no: string; title: string; year: string; tags: string[]; blurb: string; url: string; media: string; poster: string; depth?: string; color: boolean; client?: string }
// Serial position: the strongest, most on-theme piece first, the most tactile last.
export const PROJECTS: Project[] = [
  { id: 'water', no: '01', title: 'Water Sim', year: '2025', tags: ['WebGL', 'GPGPU', 'R3F'], blurb: 'A height-field you can stir, with refraction and caustics, running in a browser tab.', url: 'https://hybrid-water-sim.vercel.app', media: 'media/water-sim-color.mp4', poster: 'media/water-sim-color.webp', depth: 'media/water-sim-depth.webp', color: true },
  { id: 'audio', no: '02', title: 'Audio Viz', year: '2025', tags: ['Web Audio', 'GLSL'], blurb: 'FFT bands and beat detection drive every frame; the music is the timeline.', url: 'https://ncs-style-audio-viz.vercel.app', media: 'media/audio-viz-color.mp4', poster: 'media/audio-viz-color.webp', color: false },
  { id: 'geo', no: '03', title: 'Geo-Slash', year: '2025', tags: ['MediaPipe', 'Game'], blurb: 'A slicing game where your webcam is the controller: hand tracking in real time.', url: 'https://geo-slash.vercel.app', media: 'media/geo-slash-color.mp4', poster: 'media/geo-slash-color.webp', depth: 'media/geo-slash-depth.webp', color: true },
  { id: 'fluid', no: '04', title: 'Fluid Matter', year: '2025', tags: ['Physics', 'WebGL'], blurb: 'Rigid shapes in a stable-fluids field: fling them and they keep their momentum.', url: 'https://fluid-matter-physics.vercel.app', media: 'media/fluid-matter-color.mp4', poster: 'media/fluid-matter-color.webp', color: true },
  { id: 'jelly', no: '05', title: 'Jelly Drag', year: '2025', tags: ['Soft body', 'Shaders'], blurb: 'Soft-body UI: drag it and it squashes, overshoots and settles like the real thing.', url: 'https://jelly-drag.vercel.app', media: 'media/jelly-drag-color.mp4', poster: 'media/jelly-drag-color.webp', depth: 'media/jelly-drag-depth.webp', color: true },
]
export const TOOLS = ['React', 'R3F', 'GLSL', 'GSAP', 'Framer Motion', 'TSL / WebGPU', 'Figma', 'TypeScript']
