# README hero

`../hero-dark.webp` and `../hero-light.webp` are rendered from `scene.html`, a deterministic three.js scene: every frame depends only on its time, so a render is repeatable and the 12-second loop closes exactly. `--scale 1.3` renders 1664x832 frames, one image pixel per screen pixel when the README shows the hero 830 px wide on a 2x screen.

To render again (macOS or Linux with a GPU, Node 22, `ffmpeg` and `img2webp` from libwebp on the PATH), from the repository root:

```
npm ci
npm install --prefix docs/media/hero --no-save three@0.187.0
node docs/media/hero/render.mjs docs/media/hero --theme dark --fps 24 --scale 1.3 --out /tmp/hero-dark --webp docs/media/hero-dark.webp --q 80 --enc "-sharp_yuv -min_size"
node docs/media/hero/render.mjs docs/media/hero --theme light --fps 24 --scale 1.3 --out /tmp/hero-light --webp docs/media/hero-light.webp --q 80 --enc "-sharp_yuv -min_size"
```

To look at a few frames instead, pass times in seconds: `--at 0,4,8 --sheet /tmp/sheet.png --out /tmp/frames`. The header of `render.mjs` describes the scene contract.

The edges of each theme fade into GitHub's page colour (`#0d1117` dark, `#ffffff` light), so check the edges and the loop seam after a change, and keep both WebPs under 9 MB. Before encoding, check that no frame has a burst of pure black (dark) or near-black (light) pixels: a glass shader that overflowed once made one dark frame almost entirely black.
