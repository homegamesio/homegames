/**
 * build-bundle.js — assemble a self-contained, offline-capable Homegames
 * bundle suitable for burning to read-only media (CD/USB) or zipping up.
 *
 * The bundle ships REAL FILES (no binary packing): the full homegames-core
 * source + production node_modules, per-platform Node runtimes, a
 * dependency-free supervisor, the configured game's assets (prefetched for
 * offline play), and double-clickable launch scripts. Everything a curious
 * player opens the disc and reads.
 *
 * Usage:
 *   node build-bundle.js --game <GameKeyOrPath> [--out dist/bundle]
 *                        [--platforms darwin-arm64,darwin-x64,win-x64,linux-x64 | none]
 *                        [--iso] [--name <volumeName>]
 *
 * --game: a game key under homegames-core/src/games (e.g. "vegas-trail"), or
 *         a path to any game directory (copied into the bundle's game dir).
 *         Omit to build a dashboard bundle instead of a single-game one.
 * --platforms none: skip runtime downloads (fast iteration on bundle layout).
 * --iso: also produce an .iso (macOS hdiutil; prints the mkisofs command elsewhere).
 *
 * Writable state (config overrides, certs, saves, asset cache) always lives in
 * the player's app-data dir, so the bundle itself never needs to be writable.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const NODE_VERSION = 'v18.20.4';
const API_URL = 'https://api.homegames.io';

const RUNTIME_TARGETS = {
    'darwin-arm64': { archive: `node-${NODE_VERSION}-darwin-arm64.tar.gz`, binary: 'bin/node', out: 'node' },
    'darwin-x64': { archive: `node-${NODE_VERSION}-darwin-x64.tar.gz`, binary: 'bin/node', out: 'node' },
    'linux-x64': { archive: `node-${NODE_VERSION}-linux-x64.tar.gz`, binary: 'bin/node', out: 'node' },
    'win-x64': { archive: `node-${NODE_VERSION}-win-x64.zip`, binary: 'node.exe', out: 'node.exe' },
};

const CORE_DIR = path.dirname(require.resolve('homegames-core/package.json'));

// Junk that has no business on the disc. Paths are relative to the core copy
// root; basename patterns catch scratch files anywhere.
const EXCLUDED_PATHS = new Set([
    '.git',
    '.hg_auth',
    'hg-games',
    'wip',
    'dist',
    'tools',
    'homegames_log.txt',
    'node_modules/homegames-client/node_modules', // webpack dev deps — runtime only needs dist/ + src/
    'node_modules/homegames-client/lib-test',
    'node_modules/homegames-common/hg-games',
    'node_modules/homegames-common/vegas-trail',
    'node_modules/homegames-common/docs',
]);
const EXCLUDED_BASENAMES = [/^probe.*\.tmp\.js$/, /^\.DS_Store$/];

const log = (msg) => console.log(`[build] ${msg}`);

const parseArgs = () => {
    const args = { out: path.join(__dirname, 'dist', 'bundle'), platforms: Object.keys(RUNTIME_TARGETS), iso: false, name: 'HOMEGAMES', game: null };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--game') args.game = argv[++i];
        else if (a === '--out') args.out = path.resolve(argv[++i]);
        else if (a === '--platforms') {
            const v = argv[++i];
            args.platforms = v === 'none' ? [] : v.split(',').map(s => s.trim()).filter(Boolean);
        }
        else if (a === '--iso') args.iso = true;
        else if (a === '--name') args.name = argv[++i];
        else {
            console.error(`Unknown argument: ${a}`);
            process.exit(1);
        }
    }
    for (const p of args.platforms) {
        if (!RUNTIME_TARGETS[p]) {
            console.error(`Unknown platform ${p}. Known: ${Object.keys(RUNTIME_TARGETS).join(', ')}`);
            process.exit(1);
        }
    }
    return args;
};

// --- Copy the core tree (dereferencing the file: symlinks) -------------------

const copyCore = (bundleCoreDir) => {
    log(`Copying homegames-core from ${CORE_DIR} (dereferencing linked packages)…`);
    fs.cpSync(CORE_DIR, bundleCoreDir, {
        recursive: true,
        dereference: true,
        filter: (src) => {
            const rel = path.relative(CORE_DIR, src);
            if (!rel) return true;
            const normalized = rel.split(path.sep).join('/');
            for (const excluded of EXCLUDED_PATHS) {
                if (normalized === excluded || normalized.startsWith(excluded + '/')) return false;
            }
            const base = path.basename(src);
            if (EXCLUDED_BASENAMES.some(re => re.test(base))) return false;
            return true;
        },
    });
};

// --- Game resolution ----------------------------------------------------------

// Returns { gameKey, startPath } after making sure the game's source is inside
// the bundle's core tree (so its squish/npm requires resolve there).
const placeGame = (gameArg, bundleCoreDir) => {
    const asPath = path.resolve(gameArg);
    if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) {
        const gameKey = path.basename(asPath);
        const dest = path.join(bundleCoreDir, 'src', 'games', gameKey);
        if (!fs.existsSync(dest)) {
            log(`Copying external game ${gameKey} into the bundle…`);
            fs.cpSync(asPath, dest, { recursive: true, dereference: true });
        }
        return { gameKey, startPath: `./src/games/${gameKey}` };
    }

    // Match built-in games by exact directory entry — a case-insensitive
    // filesystem (macOS) would happily "find" src/games/Draw for the real
    // directory draw, producing a START_PATH that breaks on Linux.
    const gamesDir = path.join(bundleCoreDir, 'src', 'games');
    const actual = fs.readdirSync(gamesDir).find(entry => entry.toLowerCase() === gameArg.toLowerCase());
    if (actual && fs.existsSync(path.join(gamesDir, actual, 'index.js'))) {
        return { gameKey: actual, startPath: `./src/games/${actual}` };
    }

    throw new Error(`--game ${gameArg} is neither a directory nor a game under src/games`);
};

// --- Asset prefetch (offline play) --------------------------------------------

const fetchAsset = (assetId, destFile) => new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destFile);
    https.get(`${API_URL}/assets/${assetId}`, (res) => {
        if (res.statusCode !== 200) {
            res.resume();
            fs.unlink(destFile, () => {});
            return reject(new Error(`Asset ${assetId} fetch failed: ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('close', resolve);
        file.on('error', (err) => fs.unlink(destFile, () => reject(err)));
    }).on('error', (err) => fs.unlink(destFile, () => reject(err)));
});

// All asset declarations a bundle needs offline: the configured game's
// metadata assets plus the HomegamesRoot frame's (drawn around every hosted
// session). Parsed statically via the shared local-play module — the same
// parser the website's download path uses.
const collectAssetDeclarations = (bundleCoreDir, gameKey) => {
    const localPlay = require(path.join(CORE_DIR, 'node_modules', 'homegames-common', 'local-play.js'));

    const sources = [path.join(bundleCoreDir, 'src', 'homegames_root', 'HomegamesRoot.js')];
    if (gameKey) {
        sources.unshift(path.join(bundleCoreDir, 'src', 'games', gameKey, 'index.js'));
    }

    const byId = {};
    for (const sourcePath of sources) {
        const meta = localPlay.parseGameSourceMetadata(fs.readFileSync(sourcePath, 'utf8'));
        if (meta.error) {
            log(`Warning: could not parse metadata from ${path.basename(sourcePath)}: ${meta.error}`);
            continue;
        }
        for (const asset of meta.assets || []) {
            byId[asset.id] = asset;
        }
    }
    return Object.values(byId);
};

const prefetchAssets = async (bundleDir, bundleCoreDir, gameKey) => {
    const assets = collectAssetDeclarations(bundleCoreDir, gameKey);
    const assetsDir = path.join(bundleDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });

    log(`Prefetching ${assets.length} asset(s) for offline play…`);
    for (const asset of assets) {
        const dest = path.join(assetsDir, asset.id);
        if (fs.existsSync(dest)) continue;
        log(`  ${asset.key} (${asset.id})`);
        await fetchAsset(asset.id, dest);
    }

    fs.writeFileSync(path.join(assetsDir, 'manifest.json'), JSON.stringify(
        assets.map(a => ({ id: a.id, key: a.key, type: a.type })), null, 2
    ));
    return assets.length;
};

// --- Bundle config -------------------------------------------------------------

// The read-only base config on the disc. Networked features are OFF; the
// player's app-data config.json overlay (merged by homegames-common) is where
// LINK_ENABLED / HTTPS_ENABLED get switched on for internet multiplayer.
const writeBundleConfig = (bundleCoreDir, startPath) => {
    const config = {
        HOME_PORT: 7001,
        HOMENAMES_PORT: 7100,
        GAME_SERVER_PORT_RANGE_MIN: 7002,
        GAME_SERVER_PORT_RANGE_MAX: 7099,
        LOG_LEVEL: 'INFO',
        BEZEL_SIZE_X: 9,
        BEZEL_SIZE_Y: 9,
        DASHBOARD_PAGE_SIZE: 6,
        BUNDLED_ASSET_PATH: '../assets',
        LINK_ENABLED: false,
        HTTPS_ENABLED: false,
        FORK_SESSIONS_ENABLED: true, // no Docker on a CD player's machine
        ERROR_REPORTING: false,
        TESTS_ENABLED: false,
        PUBLIC_GAMES: false,
        IS_DEMO: false,
        SAVE_FILES_ENABLED: true,
        API_URL: 'https://api.homegames.io',
        LINK_URL: 'wss://homegames.link',
    };
    if (startPath) config.START_PATH = startPath;
    fs.writeFileSync(path.join(bundleCoreDir, 'config.json'), JSON.stringify(config, null, 4));
};

// --- Runtimes -------------------------------------------------------------------

const downloadFile = (url, dest) => new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u, redirects = 0) => {
        https.get(u, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
                res.resume();
                return get(res.headers.location, redirects + 1);
            }
            if (res.statusCode !== 200) {
                res.resume();
                fs.unlink(dest, () => {});
                return reject(new Error(`${u} -> ${res.statusCode}`));
            }
            res.pipe(file);
            file.on('close', resolve);
        }).on('error', (err) => fs.unlink(dest, () => reject(err)));
    };
    get(url);
});

const installRuntime = async (target, bundleDir) => {
    const { archive, binary, out } = RUNTIME_TARGETS[target];
    const cacheDir = path.join(os.homedir(), '.homegames-build-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cached = path.join(cacheDir, archive);

    if (!fs.existsSync(cached)) {
        const url = `https://nodejs.org/dist/${NODE_VERSION}/${archive}`;
        log(`Downloading ${url}…`);
        await downloadFile(url, cached);
    } else {
        log(`Using cached runtime ${archive}`);
    }

    const runtimeDir = path.join(bundleDir, 'runtimes', target);
    fs.mkdirSync(runtimeDir, { recursive: true });

    // bsdtar (macOS/modern linux) reads both .tar.gz and .zip
    const archiveRoot = archive.replace(/\.(tar\.gz|zip)$/, '');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-runtime-'));
    execSync(`tar -xf "${cached}" -C "${tmp}" "${archiveRoot}/${binary}"`);
    fs.copyFileSync(path.join(tmp, archiveRoot, binary), path.join(runtimeDir, out));
    fs.chmodSync(path.join(runtimeDir, out), 0o755);
    fs.rmSync(tmp, { recursive: true, force: true });

    // The Node license rides along with the runtime
    log(`Runtime ready: runtimes/${target}/${out}`);
};

// --- Launch scripts + README ----------------------------------------------------

const writeLaunchers = (bundleDir, gameKey) => {
    const title = gameKey || 'Homegames';

    const macScript = `#!/bin/bash
# ${title} — double-click to play (macOS)
cd "$(dirname "$0")"
if [ "$(uname -m)" = "arm64" ]; then RT="runtimes/darwin-arm64/node"; else RT="runtimes/darwin-x64/node"; fi
exec "./$RT" homegames/index.js
`;
    fs.writeFileSync(path.join(bundleDir, 'Play Mac.command'), macScript, { mode: 0o755 });

    const winScript = `@echo off\r
rem ${title} — double-click to play (Windows)\r
cd /d "%~dp0"\r
"runtimes\\win-x64\\node.exe" homegames\\index.js\r
pause\r
`;
    fs.writeFileSync(path.join(bundleDir, 'Play Windows.bat'), winScript);

    const linuxScript = `#!/bin/sh
# ${title} — run to play (Linux)
cd "$(dirname "$0")"
exec "./runtimes/linux-x64/node" homegames/index.js
`;
    fs.writeFileSync(path.join(bundleDir, 'play-linux.sh'), linuxScript, { mode: 0o755 });

    const readme = `${title}
${'='.repeat(title.length)}

To play:
  macOS:   double-click "Play Mac.command"
           (if blocked: open Terminal, run: bash "Play Mac.command")
  Windows: double-click "Play Windows.bat"
  Linux:   run ./play-linux.sh

A browser opens at http://localhost:7001 with the game. No internet needed.

Play together on your network (no internet needed):
  Anyone on the same wifi/LAN can join at http://<this computer's IP>:7001

Optional — internet multiplayer via homegames.link:
  Create (or edit) this file on your computer:
    macOS:   ~/Library/Application Support/homegames/config.json
    Windows: %APPDATA%\\homegames\\config.json
    Linux:   ~/.homegames/config.json
  with:
    { "LINK_ENABLED": true, "HTTPS_ENABLED": true }
  then relaunch. The server requests a certificate for your network
  (takes a few minutes) and becomes reachable at https://homegames.link.

Everything on this disc is readable source — poke around!
The server code lives in homegames-core/, the game in homegames-core/src/games/.
`;
    fs.writeFileSync(path.join(bundleDir, 'README.txt'), readme);
};

// --- ISO --------------------------------------------------------------------------

const makeIso = (bundleDir, name) => {
    const isoPath = `${bundleDir}.iso`;
    if (process.platform === 'darwin') {
        log('Creating ISO with hdiutil…');
        execSync(`hdiutil makehybrid -iso -joliet -default-volume-name "${name}" -o "${isoPath}" "${bundleDir}"`, { stdio: 'inherit' });
        log(`ISO written to ${isoPath}`);
    } else {
        log(`ISO creation is wired for macOS (hdiutil). Elsewhere, run:`);
        log(`  mkisofs -J -R -V "${name}" -o "${isoPath}" "${bundleDir}"`);
    }
};

// --- Main --------------------------------------------------------------------------

const main = async () => {
    const args = parseArgs();

    log(`Building bundle at ${args.out}`);
    // A previous bundle can contain read-only files (copied as-is from the
    // source tree) that rmSync refuses to unlink — make them writable first.
    if (fs.existsSync(args.out)) {
        try {
            execSync(`chmod -R u+w "${args.out}"`);
        } catch (e) {}
        fs.rmSync(args.out, { recursive: true, force: true });
    }
    fs.mkdirSync(args.out, { recursive: true });

    const bundleCoreDir = path.join(args.out, 'homegames-core');
    copyCore(bundleCoreDir);

    let gameKey = null;
    let startPath = null;
    if (args.game) {
        ({ gameKey, startPath } = placeGame(args.game, bundleCoreDir));
        log(`Configured game: ${gameKey} (START_PATH ${startPath})`);
    } else {
        log('No --game given — bundle boots the dashboard');
    }

    writeBundleConfig(bundleCoreDir, startPath);

    // Supervisor (dependency-free; resolves core as a sibling directory)
    const supervisorDir = path.join(args.out, 'homegames');
    fs.mkdirSync(supervisorDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'index.js'), path.join(supervisorDir, 'index.js'));

    const assetCount = await prefetchAssets(args.out, bundleCoreDir, gameKey);

    for (const target of args.platforms) {
        await installRuntime(target, args.out);
    }

    writeLaunchers(args.out, gameKey);

    if (args.iso) {
        makeIso(args.out, args.name);
    }

    const size = execSync(`du -sh "${args.out}"`).toString().split('\t')[0].trim();
    log('');
    log(`Done. Bundle: ${args.out} (${size}, ${assetCount} bundled asset(s), platforms: ${args.platforms.join(', ') || 'none'})`);
    if (!args.iso) {
        log('Add --iso to also produce a burnable image.');
    }
};

main().catch(err => {
    console.error('[build] FAILED');
    console.error(err);
    process.exit(1);
});
