// Windows only. The agent starts this detached (so jobs survive an agent restart),
// and this starts the job through cmd.exe.
//
// Why the extra step: a detached process has no console, and console programs that
// cmd.exe starts from there lose their redirected output. Started from here, cmd.exe
// gets its own (hidden) console, so the whole process tree writes to the log file.
import { spawn } from 'node:child_process';

const command = process.env.BJOBS_COMMAND;
const hide = process.env.BJOBS_HIDE !== '0';
delete process.env.BJOBS_COMMAND;
delete process.env.BJOBS_HIDE;

if (!command) process.exit(2);

const child = spawn(command, [], { shell: true, stdio: 'inherit', windowsHide: hide });
child.on('error', (err) => {
  console.error(`b_jobs: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
