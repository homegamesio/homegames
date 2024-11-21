const http = require('http');
const https = require('https');

const { getConfigValue } = require('homegames-common');

const ERROR_REPORTING_ENABLED = getConfigValue('ERROR_REPORTING_ENABLED', false);

const API_URL = getConfigValue('API_URL', null);

const electronLog = require('electron-log');

const log = {
    info: (msg) => {
        electronLog.info(JSON.stringify({message: msg}));
    }, 
    warn: (msg) => {
        electronLog.warn(JSON.stringify({message: msg}));
    },
    debug: (msg) => {
        electronLog.debug(JSON.stringify({message: msg}));
    },
    error: (msg) => {
        electronLog.error(msg);
        if (ERROR_REPORTING_ENABLED && API_URL) {
            const module = API_URL.startsWith('https') ? https : http;
            const payload = JSON.stringify({ message: msg });

            hostname = new URL(API_URL).host;

            const headers = {};

            Object.assign(headers, {
                'Content-Type': 'application/json',
                'Content-Length': payload.length
            });

            const options = {
                hostname,
                path: '/bugs',
                port: API_URL.startsWith('https') ? 443 : 80,
                method: 'POST',
                headers
            };

            let responseData = '';
        
            module.request(options);

        }
    }
};

module.exports = log;

