# Security policy

## Reporting a vulnerability

Report a vulnerability privately through [GitHub's private vulnerability reporting](https://github.com/RumyantsevMichael/Prism/security/advisories/new).
Do not open a public issue, pull request, or discussion for it.

Include what an attacker can do, the version or commit you tested, and the steps to reproduce it.
You can expect an acknowledgement within 7 days.
Once a fix ships, the advisory is published with credit to you, unless you ask to stay anonymous.

## Supported versions

Only the latest release receives security fixes.
Prism runs hooks and a local MCP server in every session where it is installed, so update to the latest release when an advisory names your version.

## Scope

In scope are the plugin's skills, hooks, MCP server, review app, native runtime, and the release packages published from this repository.
A weakness in Claude Code, Codex, or another host belongs to that host's own security process.
