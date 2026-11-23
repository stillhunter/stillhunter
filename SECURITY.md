# Security

## Reporting a vulnerability

Report it privately through GitHub's [private vulnerability reporting](https://github.com/stillhunter/stillhunter/security/advisories/new), not in a public issue. Say what you found, which version and how to reproduce it.

A way for a probe or the hunter to get past a limit the guide says is enforced counts as a vulnerability. So does a way for a run folder, the report or a kept test to leak a credential.

## What Stillhunter does and does not protect

A hunt runs code the model writes. The limits that are enforced are listed in the guide under [What a probe can and cannot do](docs/guide.md#what-a-probe-can-and-cannot-do). Two of them matter most when deciding where to run it:

- **A probe's own Node code can reach the network without restriction.** Node's permission model has no per-host network setting; only the browser is held to loopback and exact `hosts.allow` HTTPS authorities. Allowlisting trusts that host's DNS answers and any private or loopback addresses they identify.
- **A probe can print the session it signs in with, and the sign-in values it was given.** The runner masks saved-session values and every nonempty raw selected sign-in value, whatever its length, in probe output, result files, reset errors, reports and controlled CLI errors; `keep` refuses literal selected credentials. This is exact raw-value replacement, not detection of arbitrary transformed secrets: a value encoded, hashed or otherwise transformed first gets through.

So hunt a local dev server with test accounts and test data, never production or real credentials, and treat a run folder's contents as visible to the hunter.

## Supported versions

Only the latest release gets security fixes.
