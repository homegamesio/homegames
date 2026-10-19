/** Local release preparation and fail-closed S3 publication. No npm dependencies. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const BUCKET = 'homegames.io';
const PREFIX = 'builds/';
const PLATFORMS = 'darwin-arm64,darwin-x64,linux-x64,win-x64';
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const log = message => console.log(`[release] ${message}`);

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: __dirname,
        encoding: 'utf8',
        stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' },
        ...options,
    });
    if (result.error || result.status !== 0) {
        const error = new Error(`${command} ${args[0] || ''} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
        error.stderr = result.stderr || '';
        throw error;
    }
    return result.stdout || '';
}

function parseArgs(argv) {
    const options = { publish: false, noSign: false, initializeManifest: false, from: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--publish') options.publish = true;
        else if (arg === '--no-sign') options.noSign = true;
        else if (arg === '--initialize-manifest') options.initializeManifest = true;
        else if (arg === '--from') {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--from needs a release directory');
            options.from = path.resolve(argv[++i]);
        } else if (arg === '--help' || arg === '-h') options.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (options.help) return options;
    if (options.publish && options.noSign) throw new Error('Unsigned builds are local previews only; --publish cannot be combined with --no-sign.');
    if ((options.from || options.initializeManifest) && !options.publish) throw new Error('--from and --initialize-manifest require --publish.');
    return options;
}

function validateVersion(version) {
    if (typeof version !== 'string' || !VERSION_RE.test(version)) throw new Error('Invalid release version; expected a version such as 2.0.2.');
}

function validateArtifact(artifact, name, requireChecksum = false) {
    if (!artifact || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) throw new Error(`Invalid ${name} size in manifest.`);
    if ((requireChecksum || artifact.sha256 !== undefined) && !SHA256_RE.test(artifact.sha256 || '')) throw new Error(`Invalid ${name} SHA-256 in manifest.`);
}

function validateManifest(manifest) {
    if (!manifest || !Array.isArray(manifest.builds)) throw new Error('Invalid remote builds manifest; refusing to replace release history.');
    const seen = new Set();
    for (const entry of manifest.builds) {
        validateVersion(entry?.version);
        if (seen.has(entry.version)) throw new Error(`Duplicate version ${entry.version} in manifest.`);
        seen.add(entry.version);
        if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) throw new Error('Invalid release date in manifest.');
        validateArtifact(entry, 'ZIP');
        if (entry.dmg !== undefined) validateArtifact(entry.dmg, 'DMG', true);
    }
    if (manifest.latest !== null && !seen.has(manifest.latest)) throw new Error('Manifest latest does not reference a known build.');
    if (manifest.builds.length && manifest.latest === null) throw new Error('Nonempty manifest has no latest build.');
    return manifest;
}

async function describeFile(filename) {
    const stat = fs.statSync(filename);
    if (!stat.isFile() || !stat.size) throw new Error(`Missing or empty release artifact: ${filename}`);
    // S3 PutObject supports at most 5 GiB. Fail before any public writes rather
    // than silently switching to multipart and losing conditional writes.
    if (stat.size > 5 * 1024 ** 3) throw new Error(`Release artifact exceeds the 5 GiB upload limit: ${filename}`);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    return { sizeBytes: stat.size, sha256: hash.digest('hex') };
}

function verifyMacRelease(bundleDir, dmgPath, runner = run) {
    if (process.platform !== 'darwin') throw new Error('Public releases require macOS signing and notarization.');
    const app = path.join(bundleDir, 'Play Mac.app');
    if (!fs.existsSync(app) || !fs.existsSync(dmgPath)) throw new Error('Signed release is missing its Mac app or notarized DMG.');
    runner('codesign', ['--verify', '--deep', '--strict', app]);
    runner('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
    runner('xcrun', ['stapler', 'validate', dmgPath]);
}

function verifyArchive(zipPath, { dmgPath = null } = {}, runner = run) {
    runner('unzip', ['-tq', zipPath]);
    const extracted = fs.mkdtempSync(path.join(path.dirname(zipPath), 'archive-check-'));
    try {
        runner('unzip', ['-q', zipPath, '-d', extracted]);
        const bundleDir = path.join(extracted, 'homegames');
        runner(process.execPath, ['verify-bundle.js', bundleDir, '--smoke',
            ...(process.platform === 'darwin' ? ['--mac-launcher', ...(dmgPath ? ['--mac-finder'] : [])] : []), '--platforms', PLATFORMS]);
        if (dmgPath) verifyMacRelease(bundleDir, dmgPath, runner);
    } finally {
        fs.rmSync(extracted, { recursive: true, force: true });
    }
}

async function prepareRelease({ noSign, outputRoot = path.join(__dirname, 'dist') }, runner = run) {
    const version = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
    validateVersion(version);
    const dist = outputRoot;
    fs.mkdirSync(dist, { recursive: true });
    // Every attempt gets fresh output; an old DMG can never masquerade as the
    // result of this build, and failed attempts remain available for inspection.
    const directory = fs.mkdtempSync(path.join(dist, `release-${version}-`));
    const bundleDir = path.join(directory, 'homegames');
    log(`Preparing ${directory}`);
    runner(process.execPath, ['build-bundle.js', '--out', bundleDir, ...(noSign ? [] : ['--sign', '--notarize'])]);
    runner(process.execPath, ['verify-bundle.js', bundleDir, '--platforms', PLATFORMS]);
    const zipPath = path.join(directory, `homegames-${version}.zip`);
    runner('zip', ['-ryq', zipPath, 'homegames'], { cwd: directory });
    return finalizeRelease({ directory, version, noSign }, runner);
}

// Also usable after a verification failure, without rebuilding signed bytes or
// resubmitting them to Apple. The same release gates must still pass in full.
async function finalizeRelease({ directory, version, noSign = false }, runner = run) {
    validateVersion(version);
    if (fs.existsSync(path.join(directory, 'release.json'))) throw new Error('Release is already finalized; use --publish --from to publish it.');
    const zipPath = path.join(directory, `homegames-${version}.zip`);
    const dmgPath = path.join(directory, `homegames-${version}.dmg`);
    const builtDmgPath = path.join(directory, 'homegames.dmg');
    if (!noSign && fs.existsSync(builtDmgPath) && fs.existsSync(dmgPath)) throw new Error('Both built and versioned DMGs exist; refusing to overwrite either.');
    const sourceDmgPath = fs.existsSync(builtDmgPath) ? builtDmgPath : dmgPath;
    // Exercise the files people actually download and extract, including their
    // permissions and the signed app, rather than only the build working tree.
    verifyArchive(zipPath, { dmgPath: noSign ? null : sourceDmgPath }, runner);
    const zip = await describeFile(zipPath);
    const entry = { version, date: new Date().toISOString().slice(0, 10), ...zip };
    if (!noSign) {
        if (sourceDmgPath !== dmgPath) fs.renameSync(sourceDmgPath, dmgPath);
        entry.dmg = await describeFile(dmgPath);
    }
    const checksums = [`${entry.sha256}  homegames-${version}.zip`];
    if (entry.dmg) checksums.push(`${entry.dmg.sha256}  homegames-${version}.dmg`);
    fs.writeFileSync(path.join(directory, `SHA256SUMS-${version}.txt`), `${checksums.join('\n')}\n`);
    fs.writeFileSync(path.join(directory, 'release.json'), `${JSON.stringify({ signed: !noSign, entry }, null, 2)}\n`);
    return { directory, entry };
}

async function readPreparedRelease(directory, runner = run) {
    const record = JSON.parse(fs.readFileSync(path.join(directory, 'release.json'), 'utf8'));
    const { entry } = record;
    validateManifest({ latest: entry?.version, builds: [entry] });
    validateArtifact(entry, 'ZIP', true);
    if (record.signed !== true) throw new Error('Unsigned local previews cannot be published.');
    validateArtifact(entry.dmg, 'DMG', true);
    for (const [extension, expected] of [['zip', entry], ['dmg', entry.dmg]]) {
        const actual = await describeFile(path.join(directory, `homegames-${entry.version}.${extension}`));
        if (actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256) throw new Error(`${extension.toUpperCase()} changed after release verification; rebuild it.`);
    }
    const expectedChecksums = `${entry.sha256}  homegames-${entry.version}.zip\n${entry.dmg.sha256}  homegames-${entry.version}.dmg\n`;
    if (fs.readFileSync(path.join(directory, `SHA256SUMS-${entry.version}.txt`), 'utf8') !== expectedChecksums) throw new Error('Release checksum file does not match its artifacts.');
    verifyArchive(path.join(directory, `homegames-${entry.version}.zip`), { dmgPath: path.join(directory, `homegames-${entry.version}.dmg`) }, runner);
    return { directory, entry };
}

async function publishRelease({ directory, entry, distributionId, initializeManifest = false }, runner = run) {
    if (!distributionId) throw new Error('DISTRIBUTION_ID is required for publication (set it in release.env or the environment).');
    validateManifest({ latest: entry?.version, builds: [entry] });
    validateArtifact(entry, 'ZIP', true);
    validateArtifact(entry.dmg, 'DMG', true);
    const aws = args => JSON.parse(runner('aws', [...args, '--output', 'json'], { capture: true }) || '{}');
    const bucketArgs = ['--bucket', BUCKET];
    const put = (file, key, metadata, conditions = [], cacheControl = 'public,max-age=31536000,immutable') => aws([
        's3api', 'put-object', ...bucketArgs, '--key', `${PREFIX}${key}`, '--body', file,
        '--content-type', metadata.contentType, '--cache-control', cacheControl,
        '--checksum-algorithm', 'SHA256', '--checksum-sha256', Buffer.from(metadata.sha256, 'hex').toString('base64'),
        ...conditions,
    ]);
    const head = key => aws(['s3api', 'head-object', ...bucketArgs, '--key', `${PREFIX}${key}`, '--checksum-mode', 'ENABLED']);
    const verifyRemote = (key, artifact) => {
        const remote = head(key);
        if (remote.ContentLength !== artifact.sizeBytes || remote.ChecksumSHA256 !== Buffer.from(artifact.sha256, 'hex').toString('base64')) throw new Error(`S3 integrity verification failed for ${key}; latest manifest was not advanced.`);
    };
    // Conditional writes require a current AWS CLI. Check this before taking a
    // lock or uploading hundreds of megabytes.
    const skeleton = aws(['s3api', 'put-object', '--generate-cli-skeleton', 'input']);
    if (!Object.hasOwn(skeleton, 'IfMatch') || !Object.hasOwn(skeleton, 'IfNoneMatch')) throw new Error('Update AWS CLI: release publication requires conditional PutObject support.');

    const lockPath = path.join(directory, 'release-lock.json');
    fs.writeFileSync(lockPath, JSON.stringify({ version: entry.version, startedAt: new Date().toISOString(), token: crypto.randomUUID() }));
    const lockArtifact = { ...await describeFile(lockPath), contentType: 'application/json' };
    let locked = false;
    let failure;
    try {
        try {
            put(lockPath, '.release-lock.json', lockArtifact, ['--if-none-match', '*'], 'no-store');
            locked = true;
        } catch (error) {
            if (/PreconditionFailed|ConditionalRequestConflict/.test(error.stderr || error.message)) throw new Error('Another release holds builds/.release-lock.json. If its process crashed, check that it has stopped before removing the stale lock.');
            throw error;
        }
        const previousPath = path.join(directory, 'previous-manifest.json');
        let previous;
        let etag;
        try {
            const result = aws(['s3api', 'get-object', ...bucketArgs, '--key', `${PREFIX}manifest.json`, previousPath]);
            if (!result.ETag) throw new Error('Manifest download did not return an ETag; cannot safely preserve history.');
            etag = result.ETag;
            previous = validateManifest(JSON.parse(fs.readFileSync(previousPath, 'utf8')));
        } catch (error) {
            if (initializeManifest && /\(NoSuchKey\)/.test(error.stderr || error.message)) previous = { latest: null, builds: [] };
            else throw new Error(`Could not read release history; refusing publication. ${error.message}${/\(NoSuchKey\)/.test(error.stderr || error.message) ? ' Use --initialize-manifest only for the first release.' : ''}`);
        }
        const existing = previous.builds.find(build => build.version === entry.version);
        // A retry after CloudFront/alias failure may repair the same release;
        // bytes under a versioned URL must never change.
        if (existing && (existing.sha256 !== entry.sha256 || existing.dmg?.sha256 !== entry.dmg.sha256)) throw new Error(`Version ${entry.version} is already published with different bytes. Bump package.json version before releasing again.`);
        if (existing && previous.latest !== entry.version) throw new Error(`Version ${entry.version} is historical; refusing to move latest backwards.`);

        const artifacts = [
            { name: `homegames-${entry.version}.zip`, contentType: 'application/zip', ...entry },
            { name: `homegames-${entry.version}.dmg`, contentType: 'application/x-apple-diskimage', ...entry.dmg },
            { name: `SHA256SUMS-${entry.version}.txt`, contentType: 'text/plain; charset=utf-8', ...await describeFile(path.join(directory, `SHA256SUMS-${entry.version}.txt`)) },
        ];
        for (const artifact of artifacts) {
            const file = path.join(directory, artifact.name);
            try {
                put(file, artifact.name, artifact, ['--if-none-match', '*']);
            } catch (error) {
                if (!/PreconditionFailed/.test(error.stderr || error.message)) throw error;
                // An interrupted attempt may have uploaded this exact file.
                // Verify the server's checksum before resuming publication.
            }
            verifyRemote(artifact.name, artifact);
        }
        // These aliases remain backward compatible. The website uses immutable
        // versioned URLs from manifest.json; it only advances after every file
        // and alias is complete. The lock serializes publishers across machines.
        for (const artifact of artifacts) {
            const alias = artifact.name.startsWith('SHA256SUMS') ? 'SHA256SUMS.txt' : `homegames.${artifact.name.split('.').pop()}`;
            put(path.join(directory, artifact.name), alias, artifact, [], 'no-cache,max-age=0,must-revalidate');
            verifyRemote(alias, artifact);
        }
        if (!existing) {
            const manifest = { ...previous, latest: entry.version, builds: [entry, ...previous.builds] };
            const manifestPath = path.join(directory, 'manifest.json');
            fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
            put(manifestPath, 'manifest.json', { ...await describeFile(manifestPath), contentType: 'application/json' },
                etag ? ['--if-match', etag] : ['--if-none-match', '*'], 'no-cache,max-age=0,must-revalidate');
        }
        const invalidation = aws(['cloudfront', 'create-invalidation', '--distribution-id', distributionId, '--paths', '/builds/*']);
        if (!invalidation.Invalidation?.Id) throw new Error('CloudFront did not return an invalidation ID; retry this prepared release.');
        log(`Published ${entry.version}; CloudFront invalidation ${invalidation.Invalidation.Id} is in progress.`);
        log(`Download: https://homegames.io/builds/homegames-${entry.version}.zip`);
    } catch (error) {
        failure = error;
        throw error;
    } finally {
        if (locked) {
            try {
                aws(['s3api', 'delete-object', ...bucketArgs, '--key', `${PREFIX}.release-lock.json`]);
            } catch (error) {
                const message = `Could not release builds/.release-lock.json: ${error.message}`;
                if (failure) console.error(`[release] ${message}`);
                else throw new Error(message);
            }
        }
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log('Usage: ./release.sh [--no-sign | --publish [--from <release-directory>] [--initialize-manifest]]\n\nWithout --publish, build and verify locally. --no-sign creates an unsigned local preview.\nPublication requires macOS, Developer ID signing, notarization, a current AWS CLI,\nand DISTRIBUTION_ID. --from retries a prepared signed release without rebuilding.');
        return;
    }
    if (options.publish && !process.env.DISTRIBUTION_ID) throw new Error('DISTRIBUTION_ID is required for publication (set it in release.env or the environment).');
    const release = options.from ? await readPreparedRelease(options.from) : await prepareRelease(options);
    log(`Verified artifacts: ${release.directory}`);
    if (options.publish) {
        try {
            await publishRelease({ ...release, distributionId: process.env.DISTRIBUTION_ID, initializeManifest: options.initializeManifest });
        } catch (error) {
            throw new Error(`${error.message}\nAfter resolving the failure, retry the exact artifacts with:\n  ./release.sh --publish --from '${release.directory.replace(/'/g, "'\\''")}'${options.initializeManifest ? ' --initialize-manifest' : ''}`);
        }
    } else {
        log(options.noSign ? 'Local preview only: unsigned files were not published.' : `Local release only. To publish: ./release.sh --publish --from '${release.directory}'`);
    }
}

if (require.main === module) main().catch(error => { console.error(`[release] ${error.message}`); process.exitCode = 1; });

module.exports = { parseArgs, validateManifest, describeFile, prepareRelease, finalizeRelease, readPreparedRelease, publishRelease };
