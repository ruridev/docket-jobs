# Setup

How to install and run docket-jobs. For an overview, see the [README](../README.md).

## Requirements

- Node.js 22 or later

## First run

1. Clone the repository and start the agent:

   ```bash
   git clone https://github.com/ruridev/docket-jobs.git
   cd docket-jobs
   npm start
   ```

   There are no dependencies, so there is no `npm install`. Use `npm run dev` to start the agent without running any jobs.

2. Open http://127.0.0.1:8765, create your account (see [Signing in](usage.md#signing-in)) and add your jobs.
3. Make docket-jobs start at login, either with **Settings → Start docket-jobs with your PC** or:

   ```bash
   npm run autostart:on       # also: autostart:off, autostart:status
   ```

   - Windows: adds a `docket-jobs` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. It runs without a console window.
   - macOS: creates `~/Library/LaunchAgents/com.ruridev.docket-jobs.plist`, used from the next login.

| Environment variable | Default | |
| --- | --- | --- |
| `DOCKET_JOBS_PORT` | `8765` | Port to listen on (or `npm start -- --port=8766`) |
| `DOCKET_JOBS_DATA_DIR` | see [Data](usage.md#data) | Where jobs, state and logs are stored |
| `DOCKET_FRAME_ANCESTORS` | `'self' http://localhost:4600 http://127.0.0.1:4600` | Pages allowed to embed the UI (CSP `frame-ancestors`). Set `"'self'"` to allow no other page |

To update, stop the agent, run `git pull` and start it again, or log in again if autostart is on. Your jobs are in the data folder (see [Data](usage.md#data)), not in this folder. If you move this folder or reinstall Node, run `autostart:off` and `autostart:on` again. With autostart on, starting the agent from another copy of this folder points the login entry at that copy.

### Uninstalling

1. **Undo any imported startup items in the UI first.** The original entries are saved only in `<data>/`, so they cannot be restored once it is gone.
2. Run `npm run autostart:off`.
3. Stop the running jobs in the UI, stop the agent, and delete this folder and the data folder.

## Troubleshooting

**Jobs did not run after a restart.** Check `npm run autostart:status`, and that **run at startup** is on for the job. If you moved this folder or reinstalled Node, run `autostart:off` and `autostart:on`.

**On macOS, a command is not found only when started at login.** The LaunchAgent keeps the `PATH` from when autostart was turned on. If `PATH` changed since (after installing Homebrew, for example), run `autostart:off` and `autostart:on`, or use absolute paths.

**Port 8765 is already in use.** Set `DOCKET_JOBS_PORT`.

**A job failed.** Open its log in the UI, or `<data>/logs/<id>.out.log`. Check that the command works in a terminal from the job's folder.
