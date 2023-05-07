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

const linkEnabled = getConfigValue('LINK_ENABLED', false);
const httpsEnabled = getConfigValue('HTTPS_ENABLED', false);

process.env.LINK_ENABLED = linkEnabled;
process.env.HTTPS_ENABLED = httpsEnabled;

let baseDir = path.dirname(require.main.filename);

if (baseDir.endsWith('src')) {
    baseDir = baseDir.substring(0, baseDir.length - 3);
}

if (!fs.existsSync(`${baseDir}/.hg_auth`)) {
    fs.mkdirSync(`${baseDir}/.hg_auth`);
}

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
        args.push(`--cert-path=${baseDir}/hg-certs`);
    }

    if (username) {
        args.push(`--username=${username}`);
    }

    fork(`${hgCorePath}/index.js`, args);
    fork(`${hgWebPath}/index.js`, args);
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
    console.log('need to log in, get token');

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

const requestCert = (username, token) => new Promise((resolve, reject) => {
    const payload = JSON.stringify({
        localServerIp: getLocalIP()
    });

    const port = 443;
    const hostname = 'certs.homegames.link';
    const path = '/request-cert'
    const headers = {
        'hg-username': username,
        'hg-token': token
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

const getCertStatus = (username, token) => new Promise((resolve, reject) => {
    const payload = JSON.stringify({
        localServerIp: getLocalIP()
    });

    const port = 443;
    const hostname = 'certs.homegames.link';
    const path = '/cert_status'
    const headers = {
        'hg-username': username,
        'hg-token': token
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

const verifyOrRequestCert = (username) => new Promise((resolve, reject) => {
    const certDirExists = fs.existsSync(`${baseDir}/hg-certs`);
    const localCertExists = certDirExists && fs.existsSync(`${baseDir}/hg-certs/homegames.cert`);
    const localKeyExists = certDirExists && fs.existsSync(`${baseDir}/hg-certs/homegames.key`);

    if (!localCertExists) {
        console.log('need to request cert');
        if (!localKeyExists) {
            requestCertFlow();
        } else {
            console.log('I have a key but do not have a cert. Fetching cert...');
            doLogin().then(({username: _username, token: _token}) => {
                getCertStatus(_username, _token).then(_certStatus => {
                    const certStatus = _certStatus && JSON.parse(_certStatus);
                    if (!certStatus || !certStatus.certFound) {
                        console.error('No cert found for this account & device. Please contact support@homegames.io');
                    } else {
                        if (certStatus.certData) {
                            const certDataBuf = Buffer.from(certStatus.certData, 'base64');
                            fs.writeFileSync(`${baseDir}/hg-certs/homegames.cert`, certDataBuf);
                            console.log('fixed it!');
                            resolve();
                        }
                    }
                });
            });
        }
    } else {
        console.log('need to confirm the cert is not expired');
        const certString = fs.readFileSync(`${baseDir}/hg-certs/homegames.cert`);
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
    doLogin().then(({username, token}) => {
        console.log('cool!');
        requestCert(username, token).then(keyBundle => {
            console.log("KEY BUDNLE");
            console.log(keyBundle);
            const keyBuf = Buffer.from(keyBundle, 'base64');
            const keyStream = bufToStream(keyBuf);
            const unzip = unzipper.Extract({ path: baseDir });
            keyStream.pipe(unzip);

            unzip.on('close', () => {
                console.log('finished unzipping! waiting for cert...');

                const timeoutTime = Date.now() + (60 * 3 * 1000);
                let timeWaited = 0;
                const checker = setInterval(() => {
                    console.log('Checking for cert...');
                    if (Date.now() >= timeoutTime) {
                        console.error('Timed out waiting for cert');
                        clearInterval(checker);
                    } else {
                        console.log('need to check...');
                        getCertStatus(username, token).then((_currentStatus) => {
                            console.log('cert info!');
                            const currentStatus = JSON.parse(_currentStatus);
                            if (currentStatus) {
                                if (currentStatus.certData) {
                                    console.log('got cert!');
                                    clearInterval(checker);
                                    const certBuf = Buffer.from(currentStatus.certData, 'base64');
                                    fs.writeFileSync(`${baseDir}/hg-certs/homegames.cert`, certBuf);
                                    resolve();
                                }
                            }
                        });
                    }

                }, 20 * 1000);
            });
        });
 
    });
});

if (httpsEnabled) {
    console.log('sdfdsfdsfdsfdsf');
    if (fs.existsSync(`${baseDir}/.hg_auth/username`)) {
        const storedUsername = fs.readFileSync(`${baseDir}/.hg_auth/username`);
        console.log('stored username: ' + storedUsername);
        verifyOrRequestCert(storedUsername).then(main);
    } else {
        requestCertFlow().then(main);
    }
} else {
    main();
}
    //doLogin().then(({username, token}) => {
    //    getCertStatus(username, token).then((_certStatus) => {
    //        console.log('here is cert status');
    //        const certStatus = JSON.parse(_certStatus);
    //        console.log(certStatus);
    //        if (!certStatus.certFound || !certStatus.certExpiration || certStatus.certExpiration <= Date.now()) {
    //            requestCert(username, token).then(keyBundle => {
    //                console.log("KEY BUDNLE");
    //                console.log(keyBundle);
    //                const keyBuf = Buffer.from(keyBundle, 'base64');
    //                const keyStream = bufToStream(keyBuf);
    //                const unzip = unzipper.Extract({ path: baseDir });
    //                keyStream.pipe(unzip);

    //                unzip.on('close', () => {
    //                    console.log('finished unzipping! waiting for cert...');

    //                    const timeoutTime = Date.now() + (60 * 3 * 1000);
    //                    let timeWaited = 0;
    //                    const checker = setInterval(() => {
    //                        console.log('Checking for cert...');
    //                        if (Date.now() >= timeoutTime) {
    //                            console.error('Timed out waiting for cert');
    //                            clearInterval(checker);
    //                        } else {
    //                            console.log('need to check...');
    //                            getCertStatus(username, token).then((_currentStatus) => {
    //                                console.log('cert info!');
    //                                const currentStatus = JSON.parse(_currentStatus);
    //                                if (currentStatus) {
    //                                    if (currentStatus.certData) {
    //                                        console.log('got cert!');
    //                                        clearInterval(checker);
    //                                        const certBuf = Buffer.from(currentStatus.certData, 'base64');
    //                                        fs.writeFileSync(`${baseDir}/hg-certs/homegames.cert`, certBuf);
    //                                        server(`${baseDir}/hg-certs`);
    //                                    }
    //                                }
    //                            });
    //                        }

    //                    }, 20 * 1000);
    //                });
    //            });
    //        } else {
    //            // start server
    //            if (certStatus.certFound) {
    //                server(`${baseDir}/hg-certs`);
    //            } else {
    //                server();
    //            }
    //        }
    //    });
    //});


