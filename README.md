<p align="center"><img src="web/icon.svg" width="96" alt=""></p>

<h1 align="center">docket-jobs</h1>

<p align="center">Start programs with your PC, managed from a browser.</p>

docket-jobs manages the programs that should start with your PC, in one place. Instead of registering each program with the OS in its own way, you register docket-jobs once, and add, remove and switch jobs on and off from a browser.

- **Jobs**: run any command at login, with an optional delay, a restart policy and a hidden console window.
- **One autostart entry**: only the docket-jobs agent is registered with the OS. It needs no admin rights.
- **Import**: take over the startup items other programs registered, and undo it at any time.
- **Logs and status**: see which jobs are running, done or failed, with their output.
- **Pick from running servers**: choose a local web server that is already running, and docket-jobs fills in its command and folder.

It works on Windows and macOS. On Linux the agent and jobs run, but autostart and importing startup items are not supported.

## Getting started

Needs Node.js 22+.

```bash
git clone https://github.com/ruridev/docket-jobs.git
cd docket-jobs
npm start
```

Open http://127.0.0.1:8765, create your account and add your jobs. Turn on **Settings → Start docket-jobs with your PC** to run them at login. Details: [docs/setup.md](docs/setup.md).

## Security

Jobs run their command with your user's permissions, so add only commands you trust. Importing changes your OS startup items; you can undo it from the UI while the data folder is kept. docket-jobs listens on `127.0.0.1` only. Don't run it on a PC you share with other people. Details: [docs/SECURITY.md](docs/SECURITY.md).

## Documentation

- [Setup](docs/setup.md): requirements, first run, autostart, updating, uninstalling, troubleshooting
- [Usage](docs/usage.md): signing in, how jobs run, importing startup items, data
- [Security](docs/SECURITY.md): what docket-jobs protects, and how to report a vulnerability
- [Development](docs/development.md): tests

## License

[MIT](LICENSE)
