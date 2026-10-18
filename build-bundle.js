/**
 * build-bundle.js — assemble a self-contained, offline-capable Homegames
 * bundle suitable for burning to read-only media (CD/USB) or zipping up.
 *
 * The bundle ships REAL FILES (no binary packing): the full homegames-core
 * source + production node_modules, per-platform Node runtimes, a
 * dependency-free supervisor, every built-in game's local media, and
 * double-clickable launchers. Players can inspect the shipped source files.
 *
 * Usage:
 *   node build-bundle.js --game <GameKeyOrPath> [--out dist/bundle]
 *                        [--platforms darwin-arm64,darwin-x64,win-x64,linux-x64 | none]
 *                        [--iso] [--name <volumeName>]
 *                        [--sign] [--notarize] [--sign-identity <id>] [--notary-profile <name>]
 *
 * --game: a game key under homegames-core/src/games (e.g. "vegas-trail"), or
 *         a path to any game directory (copied into the bundle's game dir).
 *         Omit to build a dashboard bundle instead of a single-game one.
 * --platforms none: skip runtime downloads (fast iteration on bundle layout).
 * --iso: also produce an .iso (macOS hdiutil; prints the mkisofs command elsewhere).
 * --sign: (macOS) codesign the bundled mac Node runtimes with JIT
 *         entitlements, without building or notarizing a .dmg. Use when the
 *         bundle is distributed some other way (e.g. release.sh zips it and
 *         notarizes the zip for the website's download link).
 * --notarize: (macOS) codesign the bundled mac Node runtimes with JIT
 *         entitlements, build a .dmg, submit it to Apple notarization, and
 *         staple the ticket. Needs a Developer ID Application cert in the
 *         keychain and stored notarytool credentials:
 *           xcrun notarytool store-credentials AC_PASSWORD \
 *             --apple-id <you> --team-id <TEAMID> --password <app-specific-pw>
 *         Only needed for internet-distributed builds — burned discs never
 *         carry the quarantine attribute, so they run without notarization.
 * --sign-identity: codesign identity (default: first "Developer ID
 *         Application" in the keychain, or HG_SIGN_IDENTITY env).
 * --notary-profile: notarytool keychain profile name (default AC_PASSWORD,
 *         matching the profile the old build flow stored).
 *
 * Writable state (config overrides, certs, saves, asset cache) always lives in
 * the player's app-data dir, so the bundle itself never needs to be writable.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { copyProductionTree, packageDirectory, includeFile } = require('./build-support');

const NODE_VERSION = 'v24.22.0';

const RUNTIME_TARGETS = {
    'darwin-arm64': { archive: `node-${NODE_VERSION}-darwin-arm64.tar.gz`, binary: 'bin/node', out: 'node' },
    'darwin-x64': { archive: `node-${NODE_VERSION}-darwin-x64.tar.gz`, binary: 'bin/node', out: 'node' },
    'linux-x64': { archive: `node-${NODE_VERSION}-linux-x64.tar.gz`, binary: 'bin/node', out: 'node' },
    'win-x64': { archive: `node-${NODE_VERSION}-win-x64.zip`, binary: 'node.exe', out: 'node.exe' },
};
// Official nodejs.org/en/blog/release/v24.22.0 SHASUMS. Pin the bytes as well as
// the version, including when reusing a previously downloaded archive.
const RUNTIME_SHA256 = {
    'darwin-arm64': '6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5',
    'darwin-x64': '495e3f273c645f3c4677d438304cdfc701729ea5dec5728f5c8e76a2dece4b91',
    'linux-x64': '28ea0a438de9a13bd7891fd758eee6c7819ee8af5442dfd8d45bd65e56d4228c',
    'win-x64': 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3',
};

const CORE_DIR = path.dirname(require.resolve('homegames-core/package.json'));

const log = (msg) => console.log(`[build] ${msg}`);

const parseArgs = (argv = process.argv.slice(2)) => {
    const args = {
        out: path.join(__dirname, 'dist', 'bundle'),
        platforms: Object.keys(RUNTIME_TARGETS),
        iso: false,
        name: 'HOMEGAMES',
        game: null,
        sign: false,
        notarize: false,
        signIdentity: process.env.HG_SIGN_IDENTITY || null,
        // The keychain profile the old build flow stored credentials under —
        // reused so existing machines need no re-setup.
        notaryProfile: 'AC_PASSWORD',
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (['--game', '--out', '--platforms', '--name', '--sign-identity', '--notary-profile'].includes(a)
            && (!argv[i + 1] || argv[i + 1].startsWith('--'))) throw new Error(`Missing value for ${a}`);
        if (a === '--game') args.game = argv[++i];
        else if (a === '--out') args.out = path.resolve(argv[++i]);
        else if (a === '--platforms') {
            const v = argv[++i];
            args.platforms = v === 'none' ? [] : v.split(',').map(s => s.trim()).filter(Boolean);
        }
        else if (a === '--iso') args.iso = true;
        else if (a === '--name') args.name = argv[++i];
        else if (a === '--sign') args.sign = true;
        else if (a === '--notarize') args.notarize = true;
        else if (a === '--sign-identity') args.signIdentity = argv[++i];
        else if (a === '--notary-profile') args.notaryProfile = argv[++i];
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
    if (args.platforms.some(p => p.startsWith('darwin-')) && process.platform !== 'darwin') {
        throw new Error('Mac bundles must be built on macOS so Play Mac.app is included. Select --platforms linux-x64,win-x64 on other hosts.');
    }
    if ((args.sign || args.notarize) && !args.platforms.some(p => p.startsWith('darwin-'))) {
        throw new Error('Signing requires a macOS runtime target.');
    }
    return args;
};

// --- Copy the core tree (dereferencing the file: symlinks) -------------------

const copyCore = (bundleCoreDir) => {
    require(path.join(CORE_DIR, 'docker/prepare-context')).assertRunnerSupport(CORE_DIR);
    log(`Copying homegames-core and its installed production dependencies…`);
    copyProductionTree(CORE_DIR, bundleCoreDir);
};

// --- Game resolution ----------------------------------------------------------

// Returns { gameKey, startPath } after making sure the game's source is inside
// the bundle's core tree (so its squish/npm requires resolve there).
const placeGame = (gameArg, bundleCoreDir) => {
    const asPath = path.resolve(gameArg);
    if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) {
        const gameKey = path.basename(asPath);
        const dest = path.join(bundleCoreDir, 'src', 'games', gameKey);
        if (!fs.existsSync(path.join(asPath, 'index.js'))) throw new Error(`External game has no index.js: ${asPath}`);
        log(`Copying external game ${gameKey} into the bundle…`);
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(asPath, dest, { recursive: true, dereference: true, filter: src => includeFile(src, asPath) });
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

// --- Local media validation (offline play) --------------------------------------------

// All asset declarations a bundle needs offline: EVERY built-in game's
// metadata assets and thumbnail (so the whole library plays offline, not just
// the configured game), the HomegamesRoot frame's assets (drawn around every
// session), and the dashboard's own defaults. Parsed statically via the
// shared local-play module — the same parser the website's download path uses.
//
// Every declared asset is required: a successful build must not contain games
// that only work on the developer's already-populated asset cache.
const collectAssetDeclarations = (bundleCoreDir, gameKey) => require('./collect-local-assets').collectLocalAssets(bundleCoreDir, gameKey);

const validateLocalAssets = async (bundleDir, bundleCoreDir, gameKey) => {
    const { assets, localAssets } = collectAssetDeclarations(bundleCoreDir, gameKey);
    if (assets.length) throw new Error(`Games still require hosted assets: ${assets.map(a => a.id).join(', ')}. Migrate them into their game folders before building.`);
    // Keep the empty legacy inventory for existing launchers/verifiers. No
    // asset service is contacted: all media is now copied with its owner.
    const directory = path.join(bundleDir, 'assets'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'manifest.json'), '[]\n');
    fs.writeFileSync(path.join(bundleDir, 'local-assets.json'), JSON.stringify(localAssets, null, 2) + '\n');
    log(`Verified ${localAssets.length} local asset files; no content downloads required`);
    return localAssets.length;
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
        FORK_SESSIONS_ENABLED: false, // host opts in through Server settings
        ERROR_REPORTING: false,
        TESTS_ENABLED: false,
        PUBLIC_GAMES: false,
        RTC_SHARE_ORIGIN: 'local',
        IS_DEMO: false,
        SAVE_FILES_ENABLED: true,
        API_URL: 'https://api.homegames.io',
        LINK_URL: 'wss://homegames.link',
    };
    if (startPath) config.START_PATH = startPath;
    fs.writeFileSync(path.join(bundleCoreDir, 'config.json'), JSON.stringify(config, null, 4));
};

// --- Runtimes -------------------------------------------------------------------

const downloadFile = async (url, dest) => {
    const temporary = `${dest}.partial`;
    const get = (u, redirects = 0) => new Promise((resolve, reject) => {
        const request = https.get(u, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
                res.resume();
                return resolve(get(new URL(res.headers.location, u).href, redirects + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`${u} -> ${res.statusCode}`));
            }
            pipeline(res, fs.createWriteStream(temporary)).then(resolve, reject);
        }).on('error', reject);
        request.setTimeout(30000, () => request.destroy(new Error(`Download timed out: ${u}`)));
    });
    try {
        await get(url);
        if (!fs.statSync(temporary).size) throw new Error(`Empty download: ${url}`);
        fs.renameSync(temporary, dest);
    } finally { fs.rmSync(temporary, { force: true }); }
};

// Verify the cached archive and refresh its extracted binary. Launcher
// injection uses a separate copy and never modifies this runtime.
const getRuntimeBinary = async (target) => {
    const { archive, binary } = RUNTIME_TARGETS[target];
    const cacheDir = process.env.HG_BUILD_CACHE || path.join(__dirname, 'dist', '.runtime-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cached = path.join(cacheDir, archive);

    if (!fs.existsSync(cached)) {
        const url = `https://nodejs.org/dist/${NODE_VERSION}/${archive}`;
        log(`Downloading ${url}…`);
        await downloadFile(url, cached);
    }

    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(cached)).digest('hex');
    if (actualHash !== RUNTIME_SHA256[target]) throw new Error(`Runtime checksum mismatch: ${cached}. Remove the corrupt archive and rebuild.`);
    const archiveRoot = archive.replace(/\.(tar\.gz|zip)$/, '');
    const binPath = path.join(cacheDir, archiveRoot, path.basename(binary));
    {
        // bsdtar (macOS/modern linux) reads both .tar.gz and .zip
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-runtime-'));
        if (archive.endsWith('.zip') && process.platform !== 'darwin') {
            execFileSync('unzip', ['-q', cached, `${archiveRoot}/${binary}`, `${archiveRoot}/LICENSE`, '-d', tmp]);
        } else execFileSync('tar', ['-xf', cached, '-C', tmp, `${archiveRoot}/${binary}`, `${archiveRoot}/LICENSE`]);
        fs.mkdirSync(path.dirname(binPath), { recursive: true });
        // The builder itself may be running from this cached Node. Replacing
        // its contents in place can invalidate mapped executable pages on
        // macOS. Publish a new inode instead, also avoiding partial binaries.
        const nextBinary = binPath + '.' + crypto.randomUUID() + '.tmp';
        try {
            fs.copyFileSync(path.join(tmp, archiveRoot, binary), nextBinary);
            fs.chmodSync(nextBinary, 0o755);
            fs.renameSync(nextBinary, binPath);
        } finally { fs.rmSync(nextBinary, { force: true }); }
        fs.copyFileSync(path.join(tmp, archiveRoot, 'LICENSE'), path.join(path.dirname(binPath), 'LICENSE'));
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    return binPath;
};

const installRuntime = async (target, bundleDir) => {
    const { out } = RUNTIME_TARGETS[target];
    const binPath = await getRuntimeBinary(target);
    const runtimeDir = path.join(bundleDir, 'runtimes', target);
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.copyFileSync(binPath, path.join(runtimeDir, out));
    fs.copyFileSync(path.join(path.dirname(binPath), 'LICENSE'), path.join(runtimeDir, 'LICENSE'));
    fs.chmodSync(path.join(runtimeDir, out), 0o755);
    log(`Runtime ready: runtimes/${target}/${out}`);
};

// --- Launch scripts + README ----------------------------------------------------

// Gatekeeper permanently blocks downloaded shell scripts (they can't be
// notarized), and macOS 15+ shows bare Mach-O executables the harsh
// "cannot be verified" dialog (no Open button) even when notarized — only a
// proper .app bundle gets the normal one-click Open flow. So the mac
// launcher is a real app: Node's native single-executable support (SEA)
// turns the tiny script below into a per-arch executable (script serialized
// into a blob, injected into a copy of the official Node binary), the two
// arch slices are lipo'd into one universal binary, and that becomes the
// app's main executable — codesigned and notarized along with the bundled
// runtimes. (SEA scripts can only require built-in modules — fine here.)
const MAC_LAUNCHER_SOURCE = fs.readFileSync(path.join(__dirname, 'mac-launcher.js'), 'utf8');

const POSTJECT_VERSION = '1.0.0-alpha.6';
const MAC_APP_NAME = 'Play Mac.app';
const MAC_APP_EXECUTABLE = 'Play Mac';

// The Mac app must work when Finder translocates it or the player copies only
// the app to Applications. Windows/Linux retain the ordinary portable layout.
const writeMacPayload = (bundleDir, platforms) => {
    const contents = path.join(bundleDir, MAC_APP_NAME, 'Contents');
    const payload = path.join(contents, 'Resources', 'homegames');
    fs.mkdirSync(payload, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'build', 'icon.icns'), path.join(contents, 'Resources', 'Homegames.icns'));
    for (const name of ['homegames', 'homegames-core', 'assets', 'local-assets.json',
        'release-games.json', 'bundle-manifest.json', 'README.txt']) {
        fs.cpSync(path.join(bundleDir, name), path.join(payload, name), { recursive: true });
    }
    for (const target of platforms.filter(p => p.startsWith('darwin-'))) {
        const destination = path.join(contents, 'Helpers', `node-${target}`);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.renameSync(path.join(bundleDir, 'runtimes', target, 'node'), destination);
        // Helpers contains executable code only. Keep Node's license as a
        // resource so codesign does not attempt to treat it as nested code.
        fs.mkdirSync(path.join(payload, 'runtimes'), { recursive: true });
        fs.renameSync(path.join(bundleDir, 'runtimes', target), path.join(payload, 'runtimes', target));
    }
};

const MAC_APP_PLIST = (version) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>CFBundleExecutable</key><string>${MAC_APP_EXECUTABLE}</string>
    <key>CFBundleIdentifier</key><string>io.homegames.play</string>
    <key>CFBundleName</key><string>Homegames</string>
    <key>CFBundleIconFile</key><string>Homegames.icns</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>${version}</string>
    <key>LSMinimumSystemVersion</key><string>13.5</string>
</dict></plist>
`;

const writeMacLauncher = async (bundleDir, platforms) => {
    if (process.platform !== 'darwin') {
        log('Warning: skipping mac launcher app — building it needs macOS (codesign/lipo).');
        return;
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-sea-'));
    const src = path.join(tmp, 'launcher.js');
    const blob = path.join(tmp, 'launcher.blob');
    const seaConfig = path.join(tmp, 'sea-config.json');
    fs.writeFileSync(src, MAC_LAUNCHER_SOURCE);
    fs.writeFileSync(seaConfig, JSON.stringify({
        main: src,
        output: blob,
        disableExperimentalSEAWarning: true,
    }));

    // Generate the blob with the same Node version it gets injected into —
    // the bundled runtime for the build machine's own arch — so the build
    // machine's local node version doesn't matter. (Without useSnapshot/
    // useCodeCache the blob is arch-independent, so one blob serves both.)
    const hostTarget = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    const hostNode = await getRuntimeBinary(hostTarget);
    execFileSync(hostNode, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

    const slices = [];
    for (const runtime of platforms.filter(p => p.startsWith('darwin-'))) {
        log(`Building mac launcher slice (${runtime}) with Node SEA…`);
        const slice = path.join(tmp, `launcher-${runtime}`);
        fs.copyFileSync(await getRuntimeBinary(runtime), slice);
        fs.chmodSync(slice, 0o755);
        // Injection invalidates the nodejs.org signature; strip it first.
        execFileSync('codesign', ['--remove-signature', slice]);
        execFileSync('npx', ['-y', `postject@${POSTJECT_VERSION}`, slice, 'NODE_SEA_BLOB', blob,
            '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--macho-segment-name', 'NODE_SEA'], { stdio: 'inherit' });
        slices.push(slice);
    }

    const appDir = path.join(bundleDir, MAC_APP_NAME);
    const macosDir = path.join(appDir, 'Contents', 'MacOS');
    fs.mkdirSync(macosDir, { recursive: true });
    const exe = path.join(macosDir, MAC_APP_EXECUTABLE);
    log(`Assembling universal ${MAC_APP_NAME}…`);
    execFileSync('lipo', ['-create', ...slices, '-output', exe]);
    fs.chmodSync(exe, 0o755);

    const version = require('./package.json').version;
    fs.writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), MAC_APP_PLIST(version));
    writeMacPayload(bundleDir, platforms);

    // Ad-hoc sign so it runs at all on arm64 macs during local iteration;
    // --sign/--notarize replaces this with a Developer ID signature.
    execFileSync('codesign', ['--force', '--sign', '-', appDir]);

    fs.rmSync(tmp, { recursive: true, force: true });
};

const writeLaunchers = async (bundleDir, gameKey, platforms) => {
    const title = gameKey || 'Homegames';

    const winScript = `@echo off\r
rem ${title} — double-click to play (Windows)\r
cd /d "%~dp0"\r
"runtimes\\win-x64\\node.exe" homegames\\index.js %*\r
pause\r
`;
    if (platforms.includes('win-x64')) fs.writeFileSync(path.join(bundleDir, 'Play Windows.bat'), winScript);
    if (platforms.includes('win-x64')) fs.writeFileSync(path.join(bundleDir, 'Play Offline Windows.bat'), winScript.replace('index.js %*', 'index.js --offline %*'));

    const linuxScript = `#!/bin/sh
# ${title} — run to play (Linux)
cd "$(dirname "$0")" || exit 1
exec "./runtimes/linux-x64/node" homegames/index.js "$@"
`;
    if (platforms.includes('linux-x64')) fs.writeFileSync(path.join(bundleDir, 'play-linux.sh'), linuxScript, { mode: 0o755 });
    if (platforms.includes('linux-x64')) fs.writeFileSync(path.join(bundleDir, 'play-offline-linux.sh'), linuxScript.replace('index.js "$@"', 'index.js --offline "$@"'), { mode: 0o755 });

    const readme = `${title}
${'='.repeat(title.length)}

To play (included runtimes: ${platforms.join(', ') || 'none — development layout only; install Node.js to run homegames/index.js'}):
  First extract the ENTIRE ZIP. On Windows use Extract All; do not run inside the ZIP.
  macOS: copy Play Mac.app to Applications, then eject the disk image if used.
  The Mac app includes its own runtimes, server and games; it can be moved on its own.
  Windows/Linux: keep the launcher, runtimes, homegames-core, homegames and assets together.
  macOS 13.5 or newer: double-click "Play Mac"
           (if macOS asks about software downloaded from the internet, click Open)
  Windows: double-click "Play Windows.bat"
  Linux:   run ./play-linux.sh

A browser opens at http://localhost:7001 with the dashboard or selected game.
All built-in games and their media are included. Browsing and playing need no internet.
Import a portable game ZIP using Import ZIP on this computer. Imported games and
saves survive upgrades. On Windows/Linux you can also copy a game folder into
homegames-core/src/games and restart; on Mac, keep the signed app contents unchanged.
Windows requires 64-bit Windows 10 or newer. Linux needs x86-64, glibc 2.28+
and kernel 4.18+; Linux ARM/Raspberry Pi and Alpine/musl are not included.

Play together on your network (no internet needed):
  Anyone on the same wifi/LAN can join at http://<this computer's IP>:7001

Optional — easy LAN joining via homegames.link:
  Open Server settings in the dashboard and choose Enable homegames.link.
  The server requests a certificate in the background; local play stays available.
  When it is ready, choose Restart to enable homegames.link.
  Discovery and certificate setup/renewal need internet. Game content stays local.
  homegames.link helps devices on your network find this server; it is not a relay.

Fully offline after previously enabling online services:
  Mac: choose Play Offline in the launcher window.
  Windows: double-click Play Offline Windows.bat.
  Linux: run ./play-offline-linux.sh.
  This run uses HTTP and local RTC signaling, without changing saved preferences.
  Online invitations use the configured signaling service; offline invitations
  work on your LAN. Keep the host browser open for browser-hosted games.

Your data stays on this computer:
  macOS:   ~/Library/Application Support/homegames/
  Windows: %APPDATA%\\homegames\\
  Linux:   ~/.homegames/

Troubleshooting:
  Allow Homegames/Node through your firewall on private networks only.
  Other devices use this computer's LAN IP, not their own localhost address.
  Keep ports 7001-7099 reachable on your LAN. No router port forwarding is needed.
  On Windows/Linux keep the launch window open; close it or press Ctrl+C to stop.
  On macOS use the "Stop Homegames" button in the launcher window to stop.
  "Show Log" opens startup details; logs are in ~/Library/Logs/Homegames/.
  Saves/settings live in the app-data folder above and survive replacing the bundle.

Everything on this disc is readable source — poke around!
The server code lives in homegames-core/, the game in homegames-core/src/games/.
On Mac these are inside Play Mac.app/Contents/Resources/homegames/.
`;
    fs.writeFileSync(path.join(bundleDir, 'README.txt'), readme);
    if (platforms.some(p => p.startsWith('darwin-'))) await writeMacLauncher(bundleDir, platforms);
};

// --- Codesign + notarize (macOS internet distribution) --------------------------
// Burned discs never carry the quarantine attribute, so this is only for
// builds distributed as downloads.

// The hardened runtime (required for notarization) blocks V8's JIT unless
// these entitlements are granted — a Node binary signed without them
// notarizes fine and then crashes on launch.
const NODE_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>com.apple.security.cs.allow-jit</key><true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
`;

const resolveSignIdentity = (given) => {
    if (given) return given;
    const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning']).toString();
    const match = identities.split('\n').find(line => line.includes('Developer ID Application'));
    if (!match) {
        throw new Error('No "Developer ID Application" certificate in the keychain. '
            + 'Create one at developer.apple.com, or pass --sign-identity explicitly.');
    }
    const identity = match.match(/"([^"]+)"/)[1];
    log(`Using signing identity: ${identity}`);
    return identity;
};

// Notarization rejects the whole image if ANY Mach-O inside is unsigned —
// including native addons buried in node_modules (ssh2, cpu-features, …).
const findNativeBinaries = (dir) => {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...findNativeBinaries(full));
        else if (/\.(node|dylib)$/.test(entry.name)) results.push(full);
    }
    return results;
};

const signMacRuntimes = (bundleDir, identity) => {
    const entitlementsFile = path.join(os.tmpdir(), `hg-node-entitlements-${process.pid}.plist`);
    fs.writeFileSync(entitlementsFile, NODE_ENTITLEMENTS);

    // The launcher app's executable IS a node binary (with the SEA launcher
    // script injected), so it needs the same JIT entitlements as the bundled
    // node runtimes. Signing the .app path signs its main executable and
    // seals the bundle.
    const targets = [
        ...['darwin-arm64', 'darwin-x64'].map(t => path.join(bundleDir, MAC_APP_NAME, 'Contents', 'Helpers', `node-${t}`)),
        path.join(bundleDir, MAC_APP_NAME),
    ].filter(fs.existsSync);
    if (!targets.length) {
        throw new Error('No mac runtimes in the bundle to sign — include darwin platforms when notarizing.');
    }

    // Native addons don't need JIT entitlements, just a valid signature with
    // a secure timestamp. Files copied from the source tree can be read-only;
    // codesign rewrites the file in place, so make each writable first.
    for (const binary of findNativeBinaries(bundleDir)) {
        log(`Signing ${path.relative(bundleDir, binary)}…`);
        fs.chmodSync(binary, 0o755);
        execFileSync('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, binary], { stdio: 'inherit' });
    }

    // Sign nested code first, then seal the complete app last.
    for (const target of targets) {
        log(`Signing ${path.relative(bundleDir, target)}…`);
        execFileSync('codesign', ['--force', '--options', 'runtime', '--timestamp',
            '--entitlements', entitlementsFile, '--sign', identity, target], { stdio: 'inherit' });
    }
    fs.unlinkSync(entitlementsFile);

};

const notarize = (bundleDir, { name, signIdentity, notaryProfile }) => {
    if (process.platform !== 'darwin') {
        throw new Error('--notarize requires macOS (codesign / notarytool / stapler).');
    }

    const identity = resolveSignIdentity(signIdentity);
    signMacRuntimes(bundleDir, identity);

    const dmgPath = `${bundleDir}.dmg`;
    log('Creating dmg…');
    fs.rmSync(dmgPath, { force: true });
    // Mac downloads contain the standalone app, not a folder of dependencies.
    const imageSource = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-dmg-'));
    try {
        fs.cpSync(path.join(bundleDir, MAC_APP_NAME), path.join(imageSource, MAC_APP_NAME), { recursive: true });
        fs.copyFileSync(path.join(bundleDir, 'README.txt'), path.join(imageSource, 'README.txt'));
        execFileSync('hdiutil', ['create', '-volname', name, '-srcfolder', imageSource, '-ov', '-format', 'UDZO', dmgPath], { stdio: 'inherit' });
    } finally { fs.rmSync(imageSource, { recursive: true, force: true }); }

    log(`Submitting to Apple notarization (profile: ${notaryProfile}) — takes a few minutes…`);
    log(`(no stored credentials? run: xcrun notarytool store-credentials ${notaryProfile} --apple-id <you> --team-id <TEAMID> --password <app-specific-pw>)`);
    const notaryResult = JSON.parse(execFileSync('xcrun', ['notarytool', 'submit', dmgPath, '--keychain-profile', notaryProfile, '--wait', '--output-format', 'json'], { encoding: 'utf8' }));
    if (notaryResult.status !== 'Accepted') throw new Error(`Apple notarization ${notaryResult.status || 'failed'} (submission ${notaryResult.id || 'unknown'}).`);

    log('Stapling ticket…');
    execFileSync('xcrun', ['stapler', 'staple', dmgPath], { stdio: 'inherit' });
    execFileSync('xcrun', ['stapler', 'validate', dmgPath], { stdio: 'inherit' });
    // The ZIP is assembled afterward and gets its own copy of the app ticket.
    execFileSync('xcrun', ['stapler', 'staple', path.join(bundleDir, MAC_APP_NAME)], { stdio: 'inherit' });
    execFileSync('xcrun', ['stapler', 'validate', path.join(bundleDir, MAC_APP_NAME)], { stdio: 'inherit' });

    log(`Notarized dmg ready: ${dmgPath}`);
    return dmgPath;
};

// --- ISO --------------------------------------------------------------------------

const makeIso = (bundleDir, name) => {
    const isoPath = `${bundleDir}.iso`;
    if (process.platform === 'darwin') {
        log('Creating ISO with hdiutil…');
        execFileSync('hdiutil', ['makehybrid', '-iso', '-joliet', '-default-volume-name', name, '-o', isoPath, bundleDir], { stdio: 'inherit' });
        log(`ISO written to ${isoPath}`);
    } else {
        log(`ISO creation is wired for macOS (hdiutil). Elsewhere, run:`);
        log(`  mkisofs -J -R -V "${name}" -o "${isoPath}" "${bundleDir}"`);
    }
};

// --- Main --------------------------------------------------------------------------

const main = async () => {
    const args = parseArgs();

    if (fs.existsSync(args.out)) throw new Error(`Output already exists: ${args.out}. Choose a fresh --out directory to preserve previous builds.`);
    if (args.out === __dirname || args.out === CORE_DIR || args.out.startsWith(CORE_DIR + path.sep) || path.relative(args.out, CORE_DIR).split(path.sep)[0] !== '..') {
        throw new Error('The bundle output must not contain a source checkout.');
    }
    // Use the bundle shipped with the installed client; release builds do not
    // need that dependency's development tools or modify its installed files.
    const clientDir = packageDirectory('homegames-client', CORE_DIR);
    if (!fs.existsSync(path.join(clientDir, 'dist', 'homegames-client.js'))) {
        throw new Error('Installed homegames-client is missing its browser bundle. Reinstall dependencies, or build the client if using a local development link.');
    }
    log(`Building bundle at ${args.out}`);
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
    fs.copyFileSync(path.join(__dirname, 'mac-launcher.js'), path.join(supervisorDir, 'mac-launcher.js'));
    fs.copyFileSync(path.join(__dirname, 'release-games.json'), path.join(args.out, 'release-games.json'));
    for (const name of ['LICENSE.md', 'THIRD_PARTY_NOTICES.md']) {
        fs.copyFileSync(path.join(__dirname, name), path.join(args.out, name));
        fs.copyFileSync(path.join(__dirname, name), path.join(supervisorDir, name));
    }

    const assetCount = await validateLocalAssets(args.out, bundleCoreDir, gameKey);

    for (const target of args.platforms) {
        await installRuntime(target, args.out);
    }

    fs.writeFileSync(path.join(args.out, 'bundle-manifest.json'), JSON.stringify({
        version: require('./package.json').version,
        nodeVersion: NODE_VERSION,
        platforms: args.platforms,
        game: gameKey,
        assets: assetCount,
        builtAt: new Date().toISOString(),
    }, null, 2));
    await writeLaunchers(args.out, gameKey, args.platforms);

    // Sign the mac runtimes BEFORE producing any images so the ISO carries
    // the signed binaries too.
    if (args.notarize) {
        notarize(args.out, args);
    } else if (args.sign) {
        if (process.platform !== 'darwin') {
            throw new Error('--sign requires macOS (codesign).');
        }
        signMacRuntimes(args.out, resolveSignIdentity(args.signIdentity));
    }

    if (args.iso) {
        makeIso(args.out, args.name);
    }

    const size = execFileSync('du', ['-sh', args.out]).toString().split('\t')[0].trim();
    log('');
    log(`Done. Bundle: ${args.out} (${size}, ${assetCount} bundled asset(s), platforms: ${args.platforms.join(', ') || 'none'})`);
    if (!args.iso) {
        log('Add --iso to also produce a burnable image.');
    }
    if (!args.notarize) {
        log('Distributing as a download? Add --notarize for a signed, stapled .dmg (discs don\'t need it).');
    }
};

module.exports = { parseArgs, collectAssetDeclarations, copyCore, downloadFile, writeBundleConfig, writeLaunchers, writeMacPayload, RUNTIME_TARGETS };

if (require.main === module) main().catch(err => {
    console.error('[build] FAILED');
    console.error(err);
    process.exit(1);
});
