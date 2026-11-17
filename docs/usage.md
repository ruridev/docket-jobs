# Using docket-jobs

For setup, see [Setup](setup.md).

## Signing in

The first time you open docket-jobs, it asks you to create an account: a name and a password of 8 characters or more. There is one account and no email, because nothing is ever sent out and the account only guards this app on this PC. From then on every API call needs the signed-in session.

- Creating the account needs a setup code. While there is no account, the server prints a link with the code when it starts (`Create the account: http://127.0.0.1:8765/?setup=...`), and the code is also in `<data>/setup-code` (readable by your user only). Opening the link fills in the code; the code is removed once the account exists.
- The account is kept in `<data>/auth.json` (0600): a scrypt hash of the password and the secret that signs the session cookie. A session lasts 30 days and survives restarts.
- Browsers send `localhost` cookies to every port, so the cookie alone is not a session: signing in also gives the page an API token, kept in this browser's storage for this address only and sent with every API call. Another browser or a cleared storage asks you to sign in again.
- **Sign out** ends every session of this account, in every browser.
- Forgot the password? Run `node agent/index.js --reset-password` in this folder. It removes only the account and prints a new setup code; your data stays.

## How it works

```
login
 └─ OS autostart: the docket-jobs agent only
     └─ docket-jobs agent (background, no window)
         ├─ starts and watches the jobs in <data>/jobs.json
         ├─ writes a log per job
         └─ serves the UI on http://127.0.0.1:8765
```

- Jobs run detached from the agent. If the agent restarts, the jobs keep running and the new agent takes them over by PID.
- On Windows a job runs through `cmd.exe`, and **Hide the console window** hides only console windows; GUI programs still show their own. On macOS a job runs with `sh -c` in its own process group.

### Importing startup items

Importing turns the original entry off (or moves it to `<data>/startup-backup/`; for `/Library/LaunchAgents`, to the root-owned `/Library/Application Support/docket-jobs/startup-backup/`), and docket-jobs runs it as a job from the next login. **Undo** puts the original entry back.

| | Windows | macOS |
| --- | --- | --- |
| Sources | `HKCU` Run key, Startup folder, Task Scheduler tasks that run at your login | Login items, `~/Library/LaunchAgents`, `/Library/LaunchAgents`, background items inside apps |
| Admin approval | Task Scheduler tasks only admins can change (UAC) | `/Library/LaunchAgents` (admin password) |

- An item that ran with admin rights runs without them once imported.
- On Windows a job runs through `cmd.exe`, so Task Scheduler tasks with unquoted `&`, `|`, `<`, `>` or `^` in their arguments, or with actions in different working folders, are not offered.
- macOS does not let other programs turn off the background items inside apps. Turn those off in System Settings first, then import; after undo, turn them back on there.

## Data

The data folder (`<data>` below) is outside this folder, so deleting or cloning it again keeps your jobs and the originals of imported startup items. The agent prints its path when it starts.

| OS | `<data>` |
| --- | --- |
| macOS | `~/Library/Application Support/docket-jobs` |
| Windows | `%LOCALAPPDATA%\docket-jobs` |
| Linux | `~/.local/share/docket-jobs` (or `$XDG_DATA_HOME/docket-jobs`) |

If this folder already has a `data/` folder (from an older version), that one is used. `DOCKET_JOBS_DATA_DIR` overrides both.

| Path | Contents |
| --- | --- |
| `<data>/auth.json` | The sign-in account (password hash and session secret) |
| `<data>/jobs.json` | Jobs |
| `<data>/state.json` | PIDs of running jobs |
| `<data>/logs/<id>.jsonl` | Log per job (agent messages and program output) |
| `<data>/logs/<id>.out.log` | Raw program output |
| `<data>/imports.json`, `<data>/startup-backup/` | Imported startup items and the originals for undo (`/Library/LaunchAgents` originals are in `/Library/Application Support/docket-jobs/startup-backup/`) |

`<data>/` and the files in it are readable by your user only (mode 0700 / 0600; on Windows an access list for your user, set with `icacls`).

Theme and language are saved in the browser only.
