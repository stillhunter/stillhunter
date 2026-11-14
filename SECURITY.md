# Security

## Reporting a vulnerability

Report it privately through GitHub's [private vulnerability reporting](https://github.com/stillhunter/stillhunter/security/advisories/new), not in a public issue. Say what you found, which version and how to reproduce it.

A way for a probe or the hunter to get past a limit the README says is enforced counts as a vulnerability. So does a way for a run folder, the report or a kept test to leak a credential.

## What Stillhunter does and does not protect

A hunt runs code the model writes. The limits that are enforced are listed in the README under [What a probe can and cannot do](README.md#what-a-probe-can-and-cannot-do). Two of them matter most when deciding where to run it:

- **A probe's own Node code can reach the network.** Node's permission model has no loopback-only network setting, so only the browser is held to loopback hosts.
- **A probe can print the session it signs in with, and the sign-in values it was given.** The runner masks session values in what a probe prints, but a value the probe encodes first gets through.

So hunt a local dev server with test accounts and test data, never production or real credentials, and treat a run folder's contents as visible to the hunter.

## Supported versions

Only the latest release gets security fixes.
