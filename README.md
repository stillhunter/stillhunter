# Stillhunter

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/stillhunter/stillhunter/v0.2.5/docs/media/hero-dark.webp">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/stillhunter/stillhunter/v0.2.5/docs/media/hero-light.webp">
    <img src="https://raw.githubusercontent.com/stillhunter/stillhunter/v0.2.5/docs/media/hero-light.webp" width="830" alt="Stillhunter hunting a change to a watering app: the app splits into glass layers, a lens faults its requests with a 500, a slow reply and a malformed reply, then types -5 into the litres field. The total turns to -5 L, the bug is reproduced 2 of 2 times, confirmed as MEDIUM and kept as a test.">
  </picture>
</p>

**Find the bugs in your change before your users do.** Stillhunter is a Claude Code plugin that tests your web app change in a real browser, the way a careful QA engineer would. It reports only bugs it has seen happen twice, and you can keep each one as a test.

## Install

Inside Claude Code:

```
/plugin marketplace add stillhunter/stillhunter
/plugin install stillhunter@stillhunter
```

You also need Node.js 22.22 or later and Chrome, Edge or Chromium.

## Use

1. **Start your app** on your machine, as you do when you work on it.
2. **Tell Stillhunter where it runs** (skip this for a Nuxt app; it is found for you). Create `.stillhunter/config.json`:

   ```json
   { "target": { "url": "http://localhost:3000" } }
   ```

3. **Hunt.** Make your change on a branch, then run:

   ```
   /stillhunter:hunt
   ```

   You can also name what to look at: `/stillhunter:hunt the invite dialog`. About 10 minutes later you get a list of confirmed bugs, each with a script that shows it.

4. **Keep a bug as a test**, so you know when it is fixed:

   ```
   /stillhunter:keep 1
   /stillhunter:replay
   ```

Does your app need a sign-in? Set the test account in your shell before you start Claude Code, for example `APP_EMAIL` and `APP_PASSWORD`.

Use a local app with test data only: Stillhunter runs code the model writes against it.

## Learn more

- [Guide](https://github.com/stillhunter/stillhunter/blob/main/docs/guide.md): all commands and settings, how a hunt works, and how probes are contained
- [Benchmark](https://github.com/stillhunter/stillhunter/blob/main/benchmark/comparison/REPORT-three-arm-0.2.md): on six held-out planted bugs, three runs each, Stillhunter found the bug in 18 of 18 runs with 0.26 false alarms per run. An independent verifier confirmed 95% of its findings, and 17 of its 18 kept tests were valid. Claude Code with Playwright found 16 of 18 with about 3 false alarms per run and 47% of its findings confirmed, even when told to verify each one. Stillhunter took about three times as long and cost about 2.5 times as much per run. The recall gap is not significant; the false-alarm gap is. The [guide](https://github.com/stillhunter/stillhunter/blob/main/docs/guide.md#where-it-stands) has the full table and the earlier results.
- [Changelog](https://github.com/stillhunter/stillhunter/blob/main/CHANGELOG.md) · [Security](https://github.com/stillhunter/stillhunter/blob/main/SECURITY.md) · MIT licence
