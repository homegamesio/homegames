const { fork } = require('child_process');
const https = require('https');
const { Readable, Writable } = require('stream');
const unzipper = require('unzipper');
const { X509Certificate } = require('crypto');
const path = require('path');
const process = require('process');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

const { getConfigValue, login } = require('homegames-common');
const { app, BrowserWindow } = require('electron');

const linkEnabled = getConfigValue('LINK_ENABLED', false);
const httpsEnabled = getConfigValue('HTTPS_ENABLED', false);

process.env.LINK_ENABLED = linkEnabled;
process.env.HTTPS_ENABLED = httpsEnabled;

let baseDir = path.dirname(require.main.filename);

if (baseDir.endsWith('src')) {
    baseDir = baseDir.substring(0, baseDir.length - 3);
}

const certPath = path.join(process.cwd(), "./hg-certs");

const electronStart = () => {
    const createWindow = () => {
        const mainWindow = new BrowserWindow({
            width: 800,
            height: 600
        });

        mainWindow.loadFile('electron.html');
    };

    app.whenReady().then(() => {
        createWindow();
    
        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    });
    
    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });
};

const main = () => {
    const hgCorePath = path.join(__dirname, 'node_modules/homegames-core');
    const hgWebPath = path.join(__dirname, 'node_modules/homegames-web');

    const webBundlePath = path.join(__dirname, 'node_modules/homegames-web/web/bundle.js');

    let username;

    if (fs.existsSync(`${baseDir}/.hg_auth`) && fs.existsSync(`${baseDir}/.hg_auth/username`)) {
        username = fs.readFileSync(`${baseDir}/.hg_auth/username`);
    }

    const args = [];
    if (httpsEnabled) {
        args.push(`--cert-path=${certPath}`);
    }

    if (username) {
        args.push(`--username=${username}`);
    }

    fork(`${hgCorePath}/index.js`, args);
    fork(`${hgWebPath}/index.js`, args);

    electronStart();
};

// start of stuff

const promptUser = (promptText, hideUserInput) => new Promise((resolve, reject) => {

    let muted = false;
    
    const mutableStdout = new Writable({
        write: (chunk, encoding, callback) => {
            if (!muted) {
                process.stdout.write(chunk, encoding);
            }
            callback && callback();
        }
    });

    const rl = readline.createInterface({
        input: process.stdin,
        output: mutableStdout,
        terminal: true
    });

    rl.question(`${promptText}\n`, function(userInput) {
        rl.close();
        resolve(userInput);
    });

    muted = hideUserInput;

});

const doLogin = () => new Promise((resolve, reject) => {
    promptUser('Homegames username: ', false).then(username=> {
        promptUser('Password: ', true).then(password => {
            login(username, password).then(tokens => {
                fs.writeFileSync(`${baseDir}/.hg_auth/username`, username);
                resolve({ username, token: tokens.accessToken });
            }).catch(err => {
                console.error(err);
                reject(err);
            });
        });
    });
});

const getLocalIP = () => {
    const ifaces = os.networkInterfaces();
    let localIP;

    Object.keys(ifaces).forEach((ifname) => {
        ifaces[ifname].forEach((iface) => {
            if ('IPv4' !== iface.family || iface.internal) {
                return;
            }
            localIP = localIP || iface.address;
        });
    });

    return localIP;
};

const requestCert = () => new Promise((resolve, reject) => {
    const payload = JSON.stringify({
        localServerIp: getLocalIP()
    });

    const port = 443;
    const hostname = 'certs.homegames.link';
    const path = '/request-cert'
    const headers = {
//        'hg-username': username,
//        'hg-token': token
    };

    Object.assign(headers, {
        'Content-Type': 'application/json',
        'Content-Length': payload.length
    });

    const options = {
        hostname,
        path,
        port,
        method: 'POST',
        headers
    };

    let responseData = '';

    const req = https.request(options, (res) => {
        res.on('data', (chunk) => {
            responseData += chunk;
        });

        res.on('end', () => {
            resolve(responseData);
        });
    });

    req.write(payload);
    req.end();
});

const bufToStream = (buf) => {
    return new Readable({
        read() {
            this.push(buf);
            this.push(null);
        }
    });
};

const getCertStatus = () => new Promise((resolve, reject) => {
    const payload = JSON.stringify({
        localServerIp: getLocalIP()
    });

    const port = 443;
    const hostname = 'certs.homegames.link';
    const path = '/cert_status'
    const headers = {
//        'hg-username': username,
//        'hg-token': token
    };

    Object.assign(headers, {
        'Content-Type': 'application/json',
        'Content-Length': payload.length
    });

    const options = {
        hostname,
        path,
        port,
        method: 'POST',
        headers
    };

    let responseData = '';

    const req = https.request(options, (res) => {
        res.on('data', (chunk) => {
            responseData += chunk;
        });

        res.on('end', () => {
            resolve(responseData);
        });
    });

    req.write(payload);
    req.end();
});

// end of stuff

const verifyOrRequestCert = () => new Promise((resolve, reject) => {
    const certDirExists = fs.existsSync(`${certPath}`);
    const localCertExists = certDirExists && fs.existsSync(`${certPath}/homegames.cert`);
    const localKeyExists = certDirExists && fs.existsSync(`${certPath}/homegames.key`);

    if (!localCertExists) {
        if (!localKeyExists) {
            console.log('No cert found locally. Requesting cert...');
            requestCertFlow().then(resolve);
        } else {
            console.log('I have a key but do not have a cert. Fetching cert...');
            getCertStatus().then(_certStatus => {
                console.log("CERT STATUS!");
                console.log(_certStatus);
                const certStatus = _certStatus && JSON.parse(_certStatus);
                if (!certStatus || !certStatus.certFound) {
                    console.error('No cert found for this account & device. Please contact support@homegames.io');
                } else {
                    if (certStatus.certData) {
                        const certDataBuf = Buffer.from(certStatus.certData, 'base64');
                        fs.writeFileSync(`${certPath}/homegames.cert`, certDataBuf);
                        console.log('fixed it!');
                        resolve();
                    }
                }
            });
            //});
        }
    } else {
        console.log('need to confirm the cert is not expired');
        const certString = fs.readFileSync(`${certPath}/homegames.cert`);
        const { validTo } = new X509Certificate(certString);
        const expireTime = new Date(validTo).getTime();
        if (expireTime <= Date.now()) {
            requestCertFlow().then(resolve);
        } else {
            console.log('i know i have a valid cert');
            resolve();
        }
    }
});

const requestCertFlow = () => new Promise((resolve, reject) => {
//    doLogin().then(({username, token}) => {
        requestCert().then(keyBundle => {
            const keyBuf = Buffer.from(keyBundle, 'base64');
            const keyStream = bufToStream(keyBuf);
            const unzip = unzipper.Extract({ path: certPath });
            keyStream.pipe(unzip);

            unzip.on('close', () => {
                // hack because i have no idea why the directory is nested
                fs.copyFileSync(`${certPath}/hg-certs/homegames.key`, `${certPath}/homegames.key`);

                console.log('Downloaded key. Waiting for cert...');

                const timeoutTime = Date.now() + (60 * 3 * 1000);
                let timeWaited = 0;
                const checker = setInterval(() => {
                    console.log('Checking...');
                    if (Date.now() >= timeoutTime) {
                        console.error('Timed out waiting for cert');
                        clearInterval(checker);
                    } else {
                        getCertStatus().then((_currentStatus) => {
                            console.log('Got cert status');
                            const currentStatus = JSON.parse(_currentStatus);
                            let success = false;
                            if (currentStatus) {
                                if (currentStatus.certData) {
                                    console.log('Cert valid!');
                                    clearInterval(checker);
                                    const certBuf = Buffer.from(currentStatus.certData, 'base64');
                                    fs.writeFileSync(`${certPath}/homegames.cert`, certBuf);
                                    success = true;
                                    resolve();
                                }
                            }
                            if (!success) {
                                console.log('No cert status yet. Waiting...');
                            }
                        });
                    }

                }, 20 * 1000);
            });
        });
 
//    });
});

if (httpsEnabled) {
//    if (fs.existsSync(`${baseDir}/.hg_auth/username`)) {
//        const storedUsername = fs.readFileSync(`${baseDir}/.hg_auth/username`);
//        console.log('stored username: ' + storedUsername);
        verifyOrRequestCert().then(main);
//    } else {
//        requestCertFlow().then(main);
//    }
} else {
    main();
}

