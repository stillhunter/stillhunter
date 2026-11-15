# README hero

`../hero-dark.webp` and `../hero-light.webp` are rendered from `scene.html`, a deterministic three.js scene: every frame depends only on its time, so a render is repeatable and the 12-second loop closes exactly.

To render again (macOS or Linux with a GPU, Node 22, `ffmpeg` and `img2webp` from libwebp on the PATH), from the repository root:

```
npm ci
npm install --prefix docs/media/hero --no-save three@0.187.0
node docs/media/hero/render.mjs docs/media/hero --theme dark --fps 24 --out /tmp/hero-dark --webp docs/media/hero-dark.webp --q 75
node docs/media/hero/render.mjs docs/media/hero --theme light --fps 24 --out /tmp/hero-light --webp docs/media/hero-light.webp --q 75
```

To look at a few frames instead, pass times in seconds: `--at 0,4,8 --sheet /tmp/sheet.png --out /tmp/frames`. The header of `render.mjs` describes the scene contract.

The edges of each theme fade into GitHub's page colour (`#0d1117` dark, `#ffffff` light), so keep both WebPs under 5 MB and check the loop seam after a change.
