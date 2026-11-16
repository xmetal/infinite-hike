# Infinite Hike

An endless trail through deciduous forest, flower meadows and alpine country, rendered procedurally in the browser.
Inspired by [Abyssal Garden](https://github.com/Noniv/abyssal-garden) by Noniv and built on the same rules as its
`prompt.txt`: raw WebGPU, no engine or libraries, no image / model / sound files, one self-contained `index.html`.

## Run it

Open `index.html` in a WebGPU browser (current Chrome, Edge, or Safari 26+). Nothing to install, works offline.

| Action | Input |
|---|---|
| Walk forward / back | W / S or Up / Down |
| Auto-walk | Space |
| Jog | hold Shift |
| Look around | drag the mouse, or A / D |
| Time of day (morning, midday, golden hour, early evening) | T |
| Sound, stats, menu | M, H, Esc |

Each load starts at a random point on the trail; the menu can also jump to a forest, autumn forest, meadow or
alpine stretch. Detail (Low / Medium / High) is in the menu too. Medium is the default; try High on a fast GPU.

## How it works

- **Trail and land**: the trail is a sum of sines in x and height, so it never ends and never repeats exactly.
  Biomes cycle about every 1.4 km (forest, meadow, alpine), with a slower cycle that turns some forest stretches
  to autumn. Terrain is generated in 40 m chunks; a ring of 56 chunks (about 1.1 km each way) follows you and
  new chunks are built a stage per frame at the far, fogged end.
- **Plants**: trees are grown by recursive branching with leaf cards (three levels of detail from one random
  sequence), conifers from whorls of bough cards, plus ferns, bushes, flowers, rocks and about 40,000 grass
  blades per chunk. Leaf, needle and petal shapes are drawn in the fragment shader.
- **Light**: one sun shadow map, ray-marched volumetric light shafts through the canopy (half resolution with a
  depth-aware blur), height fog, HDR with bloom and an ACES tone curve, 4x MSAA with alpha-to-coverage foliage.
- **Life**: birds, butterflies in the meadows, falling leaves, and dust motes that light up in sunbeams.
- **Sound**: all synthesized with Web Audio: wind, leaf rustle, six kinds of birdsong, a woodpecker, meadow
  insects, a hawk in the mountains, and footsteps that change with the ground.

## index-fast.html

The same hike, drawn with less work. It skips tree, grass and rock groups that cannot reach the screen or the
shadow map (off to the side, behind you, or outside the distance range of their level of detail), so the picture
is identical. Press H for stats: it adds triangles per frame and, where the browser allows, GPU time per frame.
Press O to switch the culling off and on to compare in place.

## Edit it

Source is in `src/` (`world.js` is the place to start: trail shape, biomes, what grows where).
`node build.mjs` joins the files into `index.html` and `index-fast.html`. No dependencies.

| File | What |
|---|---|
| `src/world.js` | trail, biomes, terrain height, chunk contents |
| `src/math.js` | noise and the tree / rock / plant mesh builders |
| `src/shaders.js` | all WGSL: materials, sky, fog, light shafts, post |
| `src/main.js` | renderer, chunk streaming, camera, input |
| `src/audio.js` | the soundscape |
| `template.html` | page, menu and styles |

Test hooks (URL parameters): `?z=450` start position in metres, `?t=0..3` time of day, `?q=0..2` detail,
`?go` skip the menu.
