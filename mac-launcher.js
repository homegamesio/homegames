// Embedded as the Play Mac.app Node SEA. Keep this file dependency-free.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

// Dynamic strings are argv, never interpolated into AppleScript or shell code.
// Standard Additions displays its own dialog; it does not control Terminal or
// System Events, so no Automation/Accessibility grant is needed for those apps.
const DIALOG_SCRIPT = `on run argv
    set choices to {item 3 of argv, item 4 of argv}
    if (count of argv) > 4 then set choices to {item 5 of argv, item 3 of argv, item 4 of argv}
    set answer to display dialog (item 2 of argv) with title (item 1 of argv) buttons choices default button (item 4 of argv)
    return button returned of answer
end run`;

function macPaths(executable = process.execPath, arch = process.arch) {
    const contents = path.resolve(path.dirname(executable), '..');
    return {
        root: path.join(contents, 'Resources', 'homegames'),
        nodePath: path.join(contents, 'Helpers', `node-darwin-${arch}`),
    };
}

function startMacLauncher(options = {}) {
    // Finder may translocate only the .app. Every required file must live
    // inside it; never resolve the server/runtime relative to its parent.
    const bundled = macPaths(options.executable);
    const root = options.root || bundled.root;
    const node = options.nodePath || bundled.nodePath;
    const logDirectory = options.logDirectory || (process.env.HG_APP_DATA_DIR
        ? path.join(process.env.HG_APP_DATA_DIR, 'logs') : path.join(os.homedir(), 'Library', 'Logs', 'Homegames'));
    const logPath = path.join(logDirectory, `launcher-${process.pid}.log`);
    const interactive = options.interactive === undefined ? process.env.HG_NO_OPEN !== 'true' : options.interactive;
    const spawnProcess = options.spawnProcess || spawn;
    const exec = options.execFile || execFile;
    const graceMs = options.shutdownGraceMs === undefined ? 3000 : options.shutdownGraceMs;
    let child, dialog, logFd, stopping = false, completed = false, finishing = false;
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });

    const log = message => {
        const line = `[launcher] ${message}\n`;
        try { if (logFd !== undefined) fs.writeSync(logFd, line); } catch (_) {}
        if (!interactive) process.stderr.write(line);
    };
    const showLog = () => exec('/usr/bin/open', ['-a', 'TextEdit', logPath], error => {
        if (error) log(`Could not open the log: ${error.message}. Log file: ${logPath}`);
    });
    const closeDialog = () => {
        const current = dialog;
        dialog = null;
        if (current) current.kill('SIGTERM');
    };
    const ask = (message, first, last, callback, extra = null) => {
        const current = exec('/usr/bin/osascript', ['-e', DIALOG_SCRIPT, 'Homegames', message, first, last, ...(extra ? [extra] : [])], (error, stdout) => {
            if (dialog === current) dialog = null;
            callback(error, (stdout || '').trim());
        });
        dialog = current;
    };
    const settle = code => {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        resolveDone(code);
    };
    const finish = (code, message) => {
        if (completed) return;
        completed = true;
        closeDialog();
        log(message);
        if (logFd !== undefined) { fs.closeSync(logFd); logFd = undefined; }
        if (interactive && code !== 0 && code !== 77) {
            ask(`${message}\n\nLog file: ${logPath}\n\nIf app files are missing, download a fresh copy of Play Mac.app.`, 'Show Log', 'Close', (_error, choice) => {
                if (choice === 'Show Log') showLog();
                settle(code);
            });
        } else settle(code);
    };
    const signalGroup = signal => {
        if (!child || !child.pid) return false;
        try { process.kill(-child.pid, signal); return true; }
        catch (error) {
            if (error.code !== 'ESRCH') log(`Could not signal Homegames processes: ${error.message}`);
            return error.code !== 'ESRCH';
        }
    };
    const terminate = (code, message) => {
        if (finishing) return;
        finishing = true;
        closeDialog();
        // The supervisor and forked game servers share this new process group.
        // Kill the entire group even if the supervisor has already exited.
        signalGroup('SIGTERM');
        const deadline = Date.now() + graceMs;
        const check = () => {
            if (!signalGroup(0)) { finish(code, message); return; }
            if (Date.now() >= deadline) {
                signalGroup('SIGKILL');
                finish(code, message);
            } else setTimeout(check, 50);
        };
        check();
    };
    function stop() {
        if (completed) { closeDialog(); settle(0); return; }
        if (stopping) return;
        stopping = true;
        terminate(0, 'Homegames stopped.');
    }
    const showControls = () => {
        if (!interactive || stopping || finishing || completed) return;
        ask('Homegames is starting or running. Your browser opens when it is ready.\n\nKeep this window open while you play. Closing the browser does not stop the server.', 'Show Log', 'Stop Homegames', (error, choice) => {
            if (stopping || finishing || completed) return;
            if (!error && choice === 'Play Offline') {
                stopping = true;
                terminate(77, 'Restarting offline. Saved online settings are unchanged.');
                return;
            }
            if (error || choice !== 'Show Log') { stop(); return; }
            showLog();
            showControls();
        }, process.env.HG_OFFLINE === 'true' ? null : 'Play Offline');
    };

    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
        fs.mkdirSync(logDirectory, { recursive: true });
        logFd = fs.openSync(logPath, 'a', 0o600);
        log(`Starting ${new Date().toISOString()} from ${root}`);
        child = spawnProcess(node, [path.join(root, 'homegames', 'index.js')], {
            cwd: root, detached: true, stdio: ['ignore', logFd, logFd]
        });
        child.once('spawn', showControls);
        child.once('error', error => terminate(1, `Homegames could not start: ${error.message}`));
        child.once('exit', (code, signal) => {
            if (stopping) return;
            terminate(code === null ? 1 : code, `Homegames exited ${signal ? `with signal ${signal}` : `with code ${code}`}.`);
        });
    } catch (error) { terminate(1, `Homegames could not start: ${error.message}`); }
    return { done, stop, logPath };
}

// Node 18 can run the unit tests; the bundled Node 24 supplies node:sea.
let isSea = false;
try { isSea = require('node:sea').isSea(); } catch (_) {}
if (isSea || require.main === module) {
    (async () => {
        let code;
        do {
            code = await startMacLauncher().done;
            if (code === 77) process.env.HG_OFFLINE = 'true';
        } while (code === 77);
        process.exitCode = code;
    })();
} else {
    module.exports = { startMacLauncher, macPaths, DIALOG_SCRIPT };
}
