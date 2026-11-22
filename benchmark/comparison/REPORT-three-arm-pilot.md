# Three-arm held-out pilot, 2026-11-21

Exploratory one-trial pilot of Stillhunter 0.2.5 at commit `32ab8e1`, run with `BENCH_SET=heldout`, `claude-opus-5-5`, and a $2 per-session budget cap. The nine variants (six planted bugs and three clean features) each ran once per arm: 27 trials total. Claude Code used a Max subscription; dollar figures below are API list-price equivalents, not additional charges.

| Arm | Planted recall | Wilson 95% CI | Precision | False alarms/run | Clean-run false alarms | Median time | Total tokens | Trial cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| playwright | 5/6 | 44% to 97% | 65% | 2.89 | 2.33 | 3.0 min | 7.41M | $6.01 |
| adversarial | 5/6 | 44% to 97% | 57% | 2.56 | 2.67 | 3.8 min | 6.03M | $5.91 |
| stillhunter | 6/6 | 61% to 100% | 91% | 0.44 | 0.33 | 9.6 min | 13.62M | $12.33 |

Stillhunter alone found hx5; the other arms found the same five bugs. The paired recall difference is not established (one discordant pair, exact McNemar p = 1). False-alarm permutation p values were below 0.001 for Stillhunter against either MCP arm, but this small, unadjusted, one-trial comparison is exploratory.

All 27 trials produced readable findings without model errors, budget or hard-limit termination, application-source changes, or incomplete Stillhunter proofs. Stillhunter's proof phase took a median 97 seconds and at most 260 seconds.

Two blind judge passes classified 173 findings. Pass 1 covered every finding; pass 2 omitted two plant-journal reports. Planted-match agreement was 171/171 among comparable reports. Independent verification covered 43 distinct non-planted issues: 31 confirmed, 11 not a defect, and one not reproduced. Trial, judging and verification usage totaled about $24.25, $1.38 and $10.45 respectively.

This pilot predates independent planted-report reproduction and retained-test replay. Those dimensions were not measured, and the table does not imply them. One trial per variant measures neither run-to-run stability nor broader generalization. Raw results contain local paths and are kept outside git; this report records the measured aggregates only.
