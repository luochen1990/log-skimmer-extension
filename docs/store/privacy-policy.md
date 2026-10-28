# Privacy Policy — log-skimmer browser extension

Last updated: 2026-10-28

## What the extension does

log-skimmer highlights failure evidence and shows a summary panel on CI job-log
pages (GitHub Actions and self-hosted Forgejo). All log analysis runs **locally
in your browser** via an embedded WebAssembly engine.

## What we collect

**Nothing.** The extension has no accounts, no telemetry, no analytics, no
crash reporting, and no servers of our own. We do not collect, transmit, sell,
or share any personal data.

## What the extension reads

- Content of CI job-log pages you are viewing, matched by URL pattern
  (`github.com/*/actions/runs*`, commit-check pages, and self-hosted Forgejo
  job pages at `.../actions/runs/*`). This content is processed locally to add
  highlights and the summary panel, and is **never sent anywhere**.
- The full job log text is fetched from the same platform you are browsing,
  using your existing browser session. It stays in memory only.

## Network access

The extension fetches one public resource: the **rule bundle** (a YAML/JSON
data file, ~100 KB) from `raw.githubusercontent.com` /
`cdn.jsdelivr.net` (GitHub Pages CDN mirrors of the public
[log-skimmer-rules](https://github.com/luochen1990/log-skimmer-rules)
repository). The bundle is a **data file, not code** — it is parsed by the
local engine and can never execute. The URL can be overridden by the user
(`lsk:bundleUrl`). The fetch carries no user identifiers.

## What is stored, where

- The cached rule bundle and UI toggle state are stored in the extension's
  local storage (`chrome.storage.local`) — on your device only.
- No browsing history, log content, or credentials are ever written to disk
  or transmitted.

## Permissions rationale

| Permission                                       | Why                                                                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `storage`                                        | Cache the rule bundle locally; remember panel toggle state                                                      |
| Content-script matches on `github.com` job pages | Read the log DOM to annotate it                                                                                 |
| Path-scoped match `*://*/*/*/actions/runs*`      | Self-hosted Forgejo instances live on arbitrary domains; the pattern is restricted to CI job-log URL paths only |

## Changes

Material changes will be published in this repository and the policy date
updated.

## Contact

Open an issue at [luochen1990/log-skimmer-extension](https://github.com/luochen1990/log-skimmer-extension/issues).
