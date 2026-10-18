/**
 * Homegames supervisor.
 *
 * The whole launcher, post-Electron: start homegames-core, honor its restart
 * contract, and open a browser at the right place. Deliberately dependency-
 * free (plain Node, no npm packages) so it runs identically as a desktop
 * install and straight off read-only media (CD/USB bundles) next to a bundled
 * Node runtime.
 *
 * Restart contract (see homegames-core game_server.js requestRestart):
 *   exit 75 — restart core (apply config changes)
 *   exit 76 — restart core, then open https://homegames.link
 * Any other exit code is final.
 */

const { fork } = require('child_process');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const process = require('process');

const EXIT_RESTART = 75;
const EXIT_RESTART_OPEN_LINK = 76;

const log = (msg) => console.log(`[homegames] ${msg}`);

// --- Locate homegames-core ---------------------------------------------------
// Desktop installs resolve it as a dependency; bundles ship it as a sibling
// directory of this file.
const resolveCore = () => {
    const sibling = path.join(__dirname, '..', 'homegames-core', 'index.js');
    if (fs.existsSync(sibling)) return sibling;

    try {
        return require.resolve('homegames-core');
    } catch (e) {}

    throw new Error('Could not find homegames-core (neither as a dependency nor as a sibling directory)');
};

// --- Browser ------------------------------------------------------------------
const openExternal = (url) => {
    const opener = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'cmd.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    execFile(opener, args, (err) => {
        if (err) log(`Could not open a browser automatically — visit ${url}`);
    });
};

// --- Supervise ------------------------------------------------------------------
const main = () => {
    // A saved HTTPS/discovery preference must never prevent an offline launch.
    // This override is process-local; it does not rewrite the user's settings.
    if (process.argv.includes('--offline') || process.env.HG_OFFLINE === 'true') {
        Object.assign(process.env, { HG_OFFLINE: 'true', LINK_ENABLED: 'false', HTTPS_ENABLED: 'false',
            PUBLIC_GAMES: 'false', ERROR_REPORTING: 'false', RTC_SHARE_ORIGIN: 'local' });
    }
    const coreLocation = resolveCore();
    const coreDir = path.dirname(coreLocation);
    // Source installs keep their base config beside this launcher. Bundles
    // omit that file and ship their defaults in homegames-core instead.
    const configDir = fs.existsSync(path.join(__dirname, 'config.json')) ? __dirname : coreDir;
    log(`Using homegames-core at ${coreLocation}`);
    log(`Using base configuration at ${path.join(configDir, 'config.json')}`);

    let child = null;
    let shuttingDown = false;

    const startCore = ({ openBrowser = false, openLinkAfter = false } = {}) => {
        const current = child = fork(coreLocation, [], { cwd: configDir });
        log(`Started homegames-core (pid ${current.pid})`);
        let ready = false;
        const readyTimer = setTimeout(() => {
            log('Core has not reported ready yet — check the server logs above');
        }, 60000);
        current.on('message', message => {
            if (child !== current || ready || message?.type !== 'homegames-ready') return;
            let url;
            try {
                const address = new URL(message.url);
                if (!['http:', 'https:'].includes(address.protocol)) return;
                url = address.origin;
            } catch (_) { return; }
            ready = true; clearTimeout(readyTimer);
            if (process.env.HG_NO_OPEN === 'true' || process.argv.includes('--no-open') || !openBrowser) {
                log(`Homegames is ready — play at ${url}`);
            } else {
                const destination = openLinkAfter ? 'https://homegames.link' : url;
                log(`Homegames is ready — opening ${destination}`);
                openExternal(destination);
            }
        });

        current.on('exit', (code) => {
            clearTimeout(readyTimer);
            if (shuttingDown) return;
            if (code === EXIT_RESTART || code === EXIT_RESTART_OPEN_LINK) {
                log('Core requested a restart to apply changes');
                startCore({ openBrowser: code === EXIT_RESTART_OPEN_LINK, openLinkAfter: code === EXIT_RESTART_OPEN_LINK });
            } else {
                log(`Core exited with code ${code}`);
                process.exit(code === null ? 1 : code);
            }
        });

        current.on('error', (err) => {
            clearTimeout(readyTimer);
            console.error('[homegames] core process error');
            console.error(err);
        });
    };

    const shutdown = () => {
        shuttingDown = true;
        if (child) {
            try { child.kill(); } catch (e) {}
        }
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    startCore({ openBrowser: true });
};

main();
