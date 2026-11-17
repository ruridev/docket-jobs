# Security

For an overview, see the [README](../README.md).

## Reporting a vulnerability

Please report security problems privately through [GitHub's private vulnerability reporting](https://github.com/ruridev/docket-jobs/security/advisories/new), not in a public issue.

## What docket-jobs protects

- **Jobs run their command with your user's permissions.** Do not add a command you do not trust.
- **Importing changes your OS startup items.** You can undo it from the UI as long as `<data>/` is kept.
- The UI and the API listen on `127.0.0.1` only. Because the API can run any command, the server checks the `Host` header, the `Origin` header and a custom `X-Docket-Jobs` header to reject requests from other web pages.
- The API needs the signed-in session (see [Signing in](usage.md#signing-in)). A program running as your user can still read `<data>/`, so this is no defense against malware on your account. Don't run docket-jobs on a PC you share with other people.
- Only pages on `http://localhost:4600` may embed the UI in a frame (`DOCKET_FRAME_ANCESTORS`). If you run something else on port 4600, set `DOCKET_FRAME_ANCESTORS="'self'"`.
- The macOS administrator prompt names the startup item that is moved and where.
- Undoing an import never takes a path from `<data>/imports.json` for an admin command: `/Library/LaunchAgents` items are restored only from the root-owned backup folder, by file name.
