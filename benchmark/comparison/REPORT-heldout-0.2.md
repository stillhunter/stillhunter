# Held-out run, Stillhunter 0.2.0

Run on 2026-11-14 with `BENCH_SET=heldout`. The six held-out bugs (hx1 to hx6) were left unread while the 0.2 engine was built and tuned. Each bug ran three times per arm on the garden-log features harvest-stats, plant-journal and watering-log. Each feature also had three clean runs with no planted bug. That makes 27 runs per arm on claude-opus-5-5, with no per-run budget cap. The plugin was the packed 0.2.0 tarball (shasum 9ede6a9c47d96c0e001497b98470f06742491705). Two judge passes and three verify runs classified the findings.

| Arm | Runs | Failed runs | Planted bugs found | 95% CI | Findings | Precision | False alarms per run | Median time | Median cost |
|---|---|---|---|---|---|---|---|---|---|
| playwright | 27 | 0 | 15/18 | 61% to 94% | 238 | 64% | 3.15 | 3.9 min | $0.75 |
| stillhunter | 27 | 0 | 17/18 | 74% to 99% | 106 | 90% | 0.41 | 6.7 min | $0.79 |

Per bug (found / runs):

| Arm | hx1 | hx2 | hx3 | hx4 | hx5 | hx6 |
|---|---|---|---|---|---|---|
| playwright | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 3/3 |
| stillhunter | 3/3 | 3/3 | 3/3 | 3/3 | 2/3 | 3/3 |

Findings by class:

- playwright: 15 planted, 138 other confirmed defects (36 distinct), 85 not a defect.
- stillhunter: 18 planted observations, 77 other confirmed defects (28 distinct), 10 not a defect, 1 not reproduced.

Paired over the 18 bug runs, stillhunter alone found the bug twice and playwright alone never did. The exact McNemar p is 0.5, so this run does not show a recall difference. The drop in false alarms is clear: the permutation p is about 0.0001. Both judge passes agreed on all 344 planted matches. Stillhunter's finish step took a median of 86 s and at most 204 s, and the proof was never cut short.

Compared with the first test, 0.1 found the bug in 15 of 18 runs with 0.4 false alarms per run, and 0.2.0 found it in 17 of 18 with 0.41. The playwright arm scored lower on these bugs than it did in that test (15 of 18 now, 18 of 18 then, with a similar false-alarm rate). The two runs used different bug sets, so the numbers don't compare directly.

Caveats:

- The first pass ran without `PW_MCP_DIR`, so its playwright runs failed at once and left no results. A second pass then ran all 27 playwright runs, after the stillhunter runs. The seeded shuffle therefore did not interleave the arms in time.
- The 0.2 engine was tuned on the tuning set by the same author who ran this test. The held-out bugs were not read before this run.
- The raw results (transcripts, judge and verify output, `summary.json`) are kept out of git (`benchmark/comparison/results/`). They are 64 MB and contain local paths.
