# docket-jobs

docket-jobs manages the programs that should start with your PC, in one place. Instead of registering each program with the OS in its own way, you register docket-jobs once, and add, remove and switch jobs on and off from a browser.

- **Jobs**: run any command at login, with an optional delay, a restart policy and a hidden console window.
- **One autostart entry**: only the docket-jobs agent is registered with the OS. It needs no admin rights.
- **Import**: take over the startup items other programs registered, and undo it at any time.
- **Logs and status**: see which jobs are running, done or failed, with their output.
- **Pick from running servers**: choose a local web server that is already running, and docket-jobs fills in its command and folder.

It works on Windows and macOS. On Linux the agent and jobs run, but autostart and importing startup items are not supported.

## Requirements

- Node.js 22 or later

## Getting started

1. Clone the repository and start the agent:

   ```bash
   git clone https://github.com/ruridev/docket-jobs.git
   cd docket-jobs
   npm start
   ```

   There are no dependencies, so there is no `npm install`. Use `npm run dev` to start the agent without running any jobs.

2. Open http://127.0.0.1:8765, create your account (see [Signing in](#signing-in)) and add your jobs.
3. Make docket-jobs start at login, either with **Settings → Start docket-jobs with your PC** or:

   ```bash
   npm run autostart:on       # also: autostart:off, autostart:status
   ```

   - Windows: adds a `docket-jobs` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. It runs without a console window.
   - macOS: creates `~/Library/LaunchAgents/com.ruridev.docket-jobs.plist`, used from the next login.

| Environment variable | Default | |
| --- | --- | --- |
| `DOCKET_JOBS_PORT` | `8765` | Port to listen on (or `npm start -- --port=8766`) |
| `DOCKET_JOBS_DATA_DIR` | see [Data](#data) | Where jobs, state and logs are stored |
| `DOCKET_FRAME_ANCESTORS` | `'self' http://localhost:4600 http://127.0.0.1:4600` | Pages allowed to embed the UI (CSP `frame-ancestors`); the default is the docket portal. Set `"'self'"` if you don't use docket |

To update, stop the agent, run `git pull` and start it again, or log in again if autostart is on. Your jobs are in the data folder (see [Data](#data)), not in this folder. If you move this folder or reinstall Node, run `autostart:off` and `autostart:on` again. With autostart on, starting the agent from another copy of this folder points the login entry at that copy.

### Uninstalling

1. **Undo any imported startup items in the UI first.** The original entries are saved only in `<data>/`, so they cannot be restored once it is gone.
2. Run `npm run autostart:off`.
3. Stop the running jobs in the UI, stop the agent, and delete this folder and the data folder.

## Signing in

The first time you open docket-jobs, it asks you to create an account: a name and a password of 8 characters or more. There is one account and no email, because nothing is ever sent out and the account only guards this app on this PC. From then on every API call needs the signed-in session.

- Creating the account needs a setup code. While there is no account, the server prints a link with the code when it starts (`Create the account: http://127.0.0.1:8765/?setup=...`), and the code is also in `<data>/setup-code` (readable by your user only). Opening the link fills in the code; the code is removed once the account exists.
- The account is kept in `<data>/auth.json` (0600): a scrypt hash of the password and the secret that signs the session cookie. A session lasts 30 days and survives restarts.
- Browsers send `localhost` cookies to every port, so the cookie alone is not a session: signing in also gives the page an API token, kept in this browser's storage for this address only and sent with every API call. Another browser or a cleared storage asks you to sign in again.
- **Sign out** ends every session of this account, in every browser.
- Forgot the password? Run `node agent/index.js --reset-password` in this folder. It removes only the account and prints a new setup code; your data stays.
- docket, docket-gits and docket-jobs each have their own account. Inside the docket portal, each tool shows its own sign-in page the first time.

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

## Security

- **Jobs run their command with your user's permissions.** Do not add a command you do not trust.
- **Importing changes your OS startup items.** You can undo it from the UI as long as `<data>/` is kept.
- The UI and the API listen on `127.0.0.1` only. Because the API can run any command, the server checks the `Host` header, the `Origin` header and a custom `X-Docket-Jobs` header to reject requests from other web pages.
- The API needs the signed-in session (see [Signing in](#signing-in)). A program running as your user can still read `<data>/`, so this is no defense against malware on your account. Don't run docket-jobs on a PC you share with other people.
- Only the docket portal (`http://localhost:4600`) may embed the UI in a frame. If you don't use docket, or run something else on port 4600, set `DOCKET_FRAME_ANCESTORS="'self'"`.
- The macOS administrator prompt names the startup item that is moved and where.
- Undoing an import never takes a path from `<data>/imports.json` for an admin command: `/Library/LaunchAgents` items are restored only from the root-owned backup folder, by file name.

## Troubleshooting

**Jobs did not run after a restart.** Check `npm run autostart:status`, and that **run at startup** is on for the job. If you moved this folder or reinstalled Node, run `autostart:off` and `autostart:on`.

**On macOS, a command is not found only when started at login.** The LaunchAgent keeps the `PATH` from when autostart was turned on. If `PATH` changed since (after installing Homebrew, for example), run `autostart:off` and `autostart:on`, or use absolute paths.

**Port 8765 is already in use.** Set `DOCKET_JOBS_PORT`.

**A job failed.** Open its log in the UI, or `<data>/logs/<id>.out.log`. Check that the command works in a terminal from the job's folder.

## Related

- [docket](https://github.com/ruridev/docket): one page to open, start and stop the local web tools on your PC.
- [docket-gits](https://github.com/ruridev/docket-gits): review GitHub pull requests with an AI agent, deciding on each finding yourself.

## Development

```bash
npm test
```

## License

[MIT](LICENSE)
