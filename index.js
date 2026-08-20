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
const { exec } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const process = require('process');

const EXIT_RESTART = 75;
const EXIT_RESTART_OPEN_LINK = 76;

const log = (msg) => console.log(`[homegames] ${msg}`);

// --- Locate homegames-core ---------------------------------------------------
// Desktop installs resolve it as a dependency; bundles ship it as a sibling
// directory of this file.
const resolveCore = () => {
    try {
        return require.resolve('homegames-core');
    } catch (e) {}

    const sibling = path.join(__dirname, '..', 'homegames-core', 'index.js');
    if (fs.existsSync(sibling)) return sibling;

    throw new Error('Could not find homegames-core (neither as a dependency nor as a sibling directory)');
};

// --- Config (read-only, mirrors homegames-common's overlay semantics) --------
// env > <appData>/config.json overrides > core's config.json base.
const getAppDataPath = () => {
    switch (process.platform) {
        case 'darwin': return path.join(os.homedir(), 'Library', 'Application Support', 'homegames');
        case 'win32': return process.env.APPDATA ? path.join(process.env.APPDATA, 'homegames') : os.homedir();
        default: return path.join(os.homedir(), '.homegames');
    }
};

const readJson = (file) => {
    try {
        return JSON.parse(fs.readFileSync(file));
    } catch (e) {
        return {};
    }
};

const getConfigValue = (coreDir, key, fallback) => {
    if (process.env[key] !== undefined) return process.env[key];
    const merged = Object.assign(
        {},
        readJson(path.join(coreDir, 'config.json')),
        readJson(path.join(getAppDataPath(), 'config.json'))
    );
    return merged[key] !== undefined ? merged[key] : fallback;
};

// --- Browser ------------------------------------------------------------------
const openExternal = (url) => {
    const opener = process.platform === 'darwin' ? `open "${url}"`
        : process.platform === 'win32' ? `start "" "${url}"`
        : `xdg-open "${url}"`;
    exec(opener, (err) => {
        if (err) log(`Could not open a browser automatically — visit ${url}`);
    });
};

// Wait until the server responds, then open the browser (unless suppressed).
const openWhenReady = (url, probeUrl, attempts = 60) => {
    if (process.env.HG_NO_OPEN === 'true' || process.argv.includes('--no-open')) {
        log(`Ready check skipped browser open — play at ${url}`);
        return;
    }
    const probe = (remaining) => {
        const req = http.get(probeUrl, (res) => {
            res.resume();
            log(`Homegames is ready — opening ${url}`);
            openExternal(url);
        });
        req.on('error', () => {
            if (remaining > 0) setTimeout(() => probe(remaining - 1), 1000);
            else log(`Server never became ready — try visiting ${url} manually`);
        });
        req.setTimeout(2000, () => req.destroy(new Error('probe timeout')));
    };
    probe(attempts);
};

// --- Supervise ------------------------------------------------------------------
const main = () => {
    const coreLocation = resolveCore();
    const coreDir = path.dirname(coreLocation);
    const port = getConfigValue(coreDir, 'HOME_PORT', 7001);
    const localUrl = `http://localhost:${port}`;

    log(`Using homegames-core at ${coreLocation}`);

    let child = null;
    let shuttingDown = false;

    const startCore = ({ openLinkAfter = false } = {}) => {
        child = fork(coreLocation, [], { cwd: coreDir });
        log(`Started homegames-core (pid ${child.pid})`);

        if (openLinkAfter) {
            // The link page auto-refreshes while the instance provisions, so
            // opening as soon as we're serving again is fine.
            openWhenReady('https://homegames.link', localUrl);
        }

        child.on('exit', (code) => {
            if (shuttingDown) return;
            if (code === EXIT_RESTART || code === EXIT_RESTART_OPEN_LINK) {
                log('Core requested a restart to apply changes');
                startCore({ openLinkAfter: code === EXIT_RESTART_OPEN_LINK });
            } else {
                log(`Core exited with code ${code}`);
                process.exit(code || 0);
            }
        });

        child.on('error', (err) => {
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

    startCore();
    openWhenReady(localUrl, localUrl);
};

main();
