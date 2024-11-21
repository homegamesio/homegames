const { spawn, fork } = require('child_process');
const http = require('http');
const https = require('https');
const { Readable, Writable } = require('stream');
const unzipper = require('unzipper');
const { X509Certificate } = require('crypto');
const path = require('path');
const process = require('process');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const log = require('./logger');
const { getConfigValue, login, getAppDataPath } = require('homegames-common');
const { app, utilityProcess, BrowserWindow } = require('electron');

const linkEnabled = getConfigValue('LINK_ENABLED', false);
const httpsEnabled = getConfigValue('HTTPS_ENABLED', false);

const API_URL = getConfigValue('API_URL', 'https://api.homegames.io:443');

const API_HOST = new URL(API_URL).host;

process.env.LINK_ENABLED = linkEnabled;
process.env.HTTPS_ENABLED = httpsEnabled;
process.env.LOGGER_LOCATION = require.resolve('./logger');

let baseDir = path.dirname(require.main.filename);

if (baseDir.endsWith('src')) {
    baseDir = baseDir.substring(0, baseDir.length - 3);
}

let checkboxes = [
    {
        text: 'Local key',
        done: false
    },
    {
        text: 'Local certificate',
        done: false
    }
];

let mainWindow;

let sendUpdateHelper = (payload) => { 
    mainWindow && mainWindow.webContents.send('update', payload);
};

let sendUpdate = (newStatus, description) => {
    sendUpdateHelper({
        checkboxes,
        newStatus, 
        description
    });
};

const sendReady = () => {
    sendUpdateHelper({
        checkboxes,
        newStatus: 'Ready',
        description: 'Homegames is ready'
    });

    mainWindow && mainWindow.webContents.send('ready', '');
};

const certPath = path.join(getAppDataPath(), 'hg-certs');

const electronStart = () => new Promise((resolve, reject) => {
    if (!app) {
        return;
    }

    const createWindow = () => {
        mainWindow = new BrowserWindow({
            width: 800,
            height: 600,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js')
            }
        });

        mainWindow.loadFile('electron.html');
    };

    app.setAppLogsPath();

    app.whenReady().then(() => {
        createWindow();
    
        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });        

        resolve();
    });
    
    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });
});

const main = () => {
    const hgCorePath = path.join(__dirname, 'node_modules/homegames-core');
    const hgWebPath = path.join(__dirname, 'node_modules/homegames-web');

    const webBundlePath = path.join(__dirname, 'node_modules/homegames-web/web/bundle.js');

    const args = [];
    if (httpsEnabled) {
        args.push(`--cert-path=${certPath}`);
    }

    sendUpdate('Using app data path', getAppDataPath());

    const loggerLocation = require.resolve('./logger.js');

    const webLocation = require.resolve('homegames-web');
    const tingEnv = process.env;
    
    const forkFunc = utilityProcess ? utilityProcess.fork : fork;

    const webProc = forkFunc(webLocation, args, { env: { LOGGER_LOCATION: loggerLocation, ...tingEnv }});
    sendUpdate('Starting homegames web', `Starting homegames-web process at ${webLocation}`);

    const coreLocation = require.resolve('homegames-core');
    const coreProc = forkFunc(coreLocation, args, { env: { LOGGER_LOCATION: loggerLocation, ...tingEnv }});
    log.info("THIS IS LOGGER");
    sendUpdate('Starting homegames core', `Starting homegames-core process at ${coreLocation}`);

    webProc.on('message', (msg) => {
        log.info('got stdout from web process');
        log.info(msg);
        sendUpdate('Message from web process', msg);
    });

    webProc.on('close', (code) => {
        log.info('web process closed with code ' + code);
        sendUpdate('Web process closed', `Exit code: ${code}`);
    });

    webProc.on('error', (err) => {
        log.error('web process error');
        log.error(err);
        sendUpdate('Web process error', err);
    });

    webProc.on('exit', (code) => {
        log.info('web process exited with code ' + code);
        sendUpdate('Web process exited', `Exit code: ${code}`);
    });

    coreProc.on('message', (msg) => {
        log.info('got data from core process');
        log.info(msg);
        sendUpdate('Message from web process', msg);
    });

    coreProc.on('close', (code) => {
        log.info('core process closed with code ' + code);
        sendUpdate('Core process closed', `Exit code: ${code}`);
    });

    coreProc.on('exit', (code) => {
        log.info('core process exited with code ' + code);
        sendUpdate('Core process exited', `Exit code: ${code}`);
    });

    coreProc.on('error', (err) => {
        log.error('core process error');
        log.error(err);
        sendUpdate('Core process error', err);
    });

    sendReady();
};

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
    const hostname = API_HOST;
    const path = '/request-cert'
    const headers = {
//        'hg-username': username,
//        'hg-token': token
    };

    log.info("WAT");
    log.info(hostname);

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
            log.info('Request cert success');
            if (res.statusCode > 199 && res.statusCode < 300) {
                resolve(responseData);
            } else {
                reject(responseData);
            }
        });
    });

    log.info('Request cert start');
    req.write(payload);
    req.end();
});
//
const bufToStream = (buf) => {
    return new Readable({
        read() {
            this.push(buf);
            this.push(null);
        }
    });
};
//
const getCertStatus = () => new Promise((resolve, reject) => {
    const payload = JSON.stringify({
        localServerIp: getLocalIP()
    });

    const port = 443;
    const hostname = API_HOST;
    const path = '/cert-status'
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
        method: 'GET',
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

const verifyOrRequestCert = () => new Promise((resolve, reject) => {
    const certDirExists = fs.existsSync(`${certPath}`);
    log.info('what is certpath ' + certPath);
    const localCertExists = certDirExists && fs.existsSync(`${certPath}/homegames.cert`);
    const localKeyExists = certDirExists && fs.existsSync(`${certPath}/homegames.key`);

    if (!localCertExists) {
        if (!localKeyExists) {
            log.info('No cert found locally. Requesting cert...');
            sendUpdate('Requesting cert', 'Requesting a certificate from the Homegames API');
            requestCertFlow().then(resolve).catch(err => {
                sendUpdate('Failure requesting cert', 'Encountered a failure when requesting cert: ' + err);
                log.error('Failure getting cert');
                log.error(err);
            });
        } else {
            log.info('I have a key but do not have a cert. Fetching cert...');
            sendUpdate('I have a key but do not have a cert.', 'Fetching certificate');
            getCertStatus().then(_certStatus => {
                log.info("CERT STATUS! " + _certStatus);
                sendUpdate('Checking cert status', _certStatus); 
                const certStatus = _certStatus && JSON.parse(_certStatus);
                if (!certStatus || !certStatus.certFound) {
                    sendUpdate('Error', 'Please contact support@homegames.io');
                    console.error('No cert found for this account & device. Please contact support@homegames.io');
                } else {
                    if (certStatus.cert) {
                        const certDataBuf = Buffer.from(certStatus.cert, 'base64');
                        fs.writeFileSync(`${certPath}/homegames.cert`, certDataBuf);
                        log.info('fixed it!');
                        sendUpdate('Got cert data', 'Downloaded cert');
                        resolve();
                    }
                }
            });
            //});
        }
    } else {
        log.info('need to confirm the cert is not expired');
        sendUpdate('Confirming cert status', 'Confirming valid local cert');
        const certString = fs.readFileSync(`${certPath}/homegames.cert`);
        const { validTo } = new X509Certificate(certString);
        const expireTime = new Date(validTo).getTime();
        if (expireTime <= Date.now()) {
            sendUpdate('Cert expired', 'Getting new cert');
            requestCertFlow().then(resolve);
        } else {
            log.info('i know i have a valid cert');
            sendUpdate('certConfirmed', 'Confirmed valid local certificate at ' + certPath);
            resolve();
        }
    }
});
//
const requestCertFlow = () => new Promise((resolve, reject) => {
//    doLogin().then(({username, token}) => {
        requestCert().then(keyBundle => {
            const keyBuf = Buffer.from(keyBundle, 'base64');
            const keyStream = bufToStream(keyBuf);
            const unzip = unzipper.Extract({ path: certPath });
            keyStream.pipe(unzip);

            unzip.on('close', () => {
                fs.copyFileSync(`${certPath}/homegames.key`, `${certPath}/homegames.key`);

                log.info('Downloaded key. Waiting for cert...');
                sendUpdate('Key created', 'Waiting for certificate from Homegames API');

                const timeoutTime = Date.now() + (60 * 5 * 1000); // 5 mins
                let timeWaited = 0;
                const checker = setInterval(() => {
                    log.info('Checking...');
                    sendUpdate('Checking cert status', 'Fetching current status from Homegames API');
                    if (Date.now() >= timeoutTime) {
                        log.error('Timed out waiting for cert');
                        sendUpdate('Error', 'Timed out waiting for certificate. Try again later or contact support@homegames.io for help');
                        clearInterval(checker);
                    } else {
                        getCertStatus().then((_currentStatus) => {
                            log.info('Got cert status');
                            sendUpdate('Fetched cert status', 'Successfully fetched cert data');
                            const currentStatus = JSON.parse(_currentStatus);
                            let success = false;
                            if (currentStatus) {
                                if (currentStatus.cert) {
                                    log.info('Cert valid!');
                                    sendUpdate('Valid cert', 'Got valid cert from Homegames API');
                                    clearInterval(checker);
                                    const certBuf = Buffer.from(currentStatus.cert, 'base64');
                                    fs.writeFileSync(`${certPath}/homegames.cert`, certBuf);
                                    success = true;
                                    resolve();
                                }
                            }
                            if (!success) {
                                log.info('No cert status yet. Waiting...');
                                sendUpdate('Cert not ready yet', 'Waiting...');
                            }
                        });
                    }

                }, 20 * 1000);
            });
        }).catch(err => {
            log.error('Failed requesting cert');
            log.error(err);
            sendUpdate('Error requesting cert', err);
            reject(err);
        });
 
//    });
});


const homegamesMain = () => {
    if (httpsEnabled) {
        verifyOrRequestCert().then(main);
    } else {
        main();
    }
}

if (app) {
    electronStart().then(() => {
        homegamesMain();
    });
} else {
    homegamesMain();
}


