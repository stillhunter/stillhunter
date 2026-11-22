# Three-arm held-out evaluation, 2026-11-22

Three-trial evaluation of Stillhunter 0.2.5, with the plugin packed at commit `5766089`, using `BENCH_SET=heldout`, `claude-opus-5-5`, and a $2 per-session budget cap. Nine variants (six planted bugs and three clean features) each ran three times per arm: 81 trials total. Claude Code used a Max subscription; dollar figures are API list-price equivalents, not additional charges.

## Detection and evidence quality

| Arm | Planted recall | Wilson 95% CI | Precision (95% CI) | False alarms/run | Clean-run false alarms | Planted reports independently confirmed (95% CI) | Valid retained tests (95% CI) |
|---|---:|---:|---:|---:|---:|---:|---:|
| playwright | 16/18 | 67% to 97% | 47% (40% to 55%) | 3.37 | 3.67 | 16/16 (81% to 100%) | 12/16 (51% to 90%) |
| adversarial | 16/18 | 67% to 97% | 47% (40% to 55%) | 3.07 | 3.22 | 16/16 (81% to 100%) | 14/16 (64% to 97%) |
| stillhunter | 18/18 | 82% to 100% | 95% (91% to 98%) | 0.26 | 0.22 | 18/18 (82% to 100%) | 17/18 (74% to 99%) |

All arms found hx1, hx2, hx3, hx4 and hx6 in every trial. Stillhunter found hx5 in all three trials; Playwright and the adversarial arm each found it once. The paired recall advantage is not established: Stillhunter had two discordant pairs in its favor against either arm, exact McNemar p = 0.5. Adversarial versus Playwright had one discordant pair in each direction, p = 1.

False-alarm permutation p values were approximately 0.0001 for Stillhunter against either MCP arm; adversarial versus Playwright was p = 0.363. These are small, unadjusted comparisons, not evidence of broad generalization. In this measurement, the explicit adversarial prompt did not improve aggregate recall or precision over Playwright.

Precision includes independently confirmed planted and non-planted findings. False alarms combine not-a-defect and not-reproduced reports. Every finding was judged and every resulting verification job reached a decisive verdict, so these rates are not conditional on dropping unverified reports.

## Time, tokens and price

| Arm | Findings | Median time | Total tokens | Median trial price | Total trial price |
|---|---:|---:|---:|---:|---:|
| playwright | 173 | 3.6 min | 15.31M | $0.62 | $16.82 |
| adversarial | 158 | 4.4 min | 18.22M | $0.64 | $18.57 |
| stillhunter | 148 | 11.3 min | 44.03M | $1.55 | $40.87 |

Token totals include input, output, cache-read and cache-write tokens. Observed per-trial time ranges were 1.7–5.4 minutes for Playwright, 2.3–35.7 for adversarial and 6.2–44.5 for Stillhunter. Token ranges were 0.36M–0.78M, 0.36M–1.04M and 0.89M–2.30M respectively; list-price ranges were $0.43–$0.77, $0.44–$0.94 and $0.95–$3.01. These ranges describe observed variability, not confidence intervals.

Stillhunter's higher detection precision and retained-test validity came with roughly three times Playwright's median wall time and token total. Its deterministic proof ran after the stated hunting budget; adversarial validation was inside the other arms' hunting budget. This asymmetry could affect precision and retained-test quality, so total time and price are reported rather than treated as equivalent.

Final scored trials, judging and verification cost $76.27, $3.40 and $28.85 respectively, totaling $108.52 in API list-price equivalents. An additional $0.31 was spent on the first, rate-limited verification attempts.

## Independent verification and judging

Two blind judge passes covered all 479 findings with no missing, duplicate or unknown IDs. Planted-match agreement was 479/479 between passes.

Independent verification covered 50 individual planted reports and 59 grouped non-planted issues. All 50 planted reports were confirmed with reproduction and expectation validity checked separately. The 109 final verdicts comprised 90 confirmed, 16 not-a-defect and three not-reproduced; none remained inconclusive or unverified.

The first verification pass confirmed five reports, then hit Claude's five-hour usage limit. The 104 rate-limited attempts were preserved outside the scored results and retried after the reset. They were never counted as reproduced or not reproduced.

## Retained regression tests

Every planted finding had a retained test available. A valid test failed twice on its buggy variant and passed on clean code; an expectation that was never reached remained inconclusive. Across arms, 43 tests were valid, three had wrong expectations and four were inconclusive. None was missing, unstable or insensitive to its bug.

| Arm | Available | Valid | Wrong expectation | Inconclusive |
|---|---:|---:|---:|---:|
| playwright | 16 | 12 | 3 | 1 |
| adversarial | 16 | 14 | 0 | 2 |
| stillhunter | 18 | 17 | 0 | 1 |

The first replay pass exposed two harness defects: MCP tests were copied without helper modules, and Stillhunter tests could run on ports different from those captured in their probes. The harness now copies the MCP test suite and schedules Stillhunter on its original lane, with focused regression tests. The 21 affected evaluations were rerun; their infrastructure-affected first attempts remain preserved outside the scored results.

These measurements cover planted-finding tests only. They do not measure subjective readability, maintainability or the quality of tests for non-planted findings.

## Run integrity and limits

All 81 trials produced readable findings. None had a model error, nonzero exit, budget or hard-limit termination, application-source modification, or incomplete Stillhunter proof. Two Stillhunter runs each recorded one denied command and continued successfully. Stillhunter's proof phase took a median 104 seconds and at most 1043 seconds. No comparison application remained listening after replay.

Three trials across six planted bugs in one application family measure repeatability on this evaluation, not broad generalization to other applications, models or bug classes. Raw transcripts and results contain local paths and remain outside git; this report records measured aggregates and handling of incomplete attempts. The earlier [one-trial pilot](REPORT-three-arm-pilot.md) is a separate exploratory measurement and is not pooled with these results.
