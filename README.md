This is a test hello

This package simply pulls in both homegames-web & homegames-core and runs them.

```
npm install
npm run build
npm start
```

Change this line in `index.js` to disable homegames.link functionality:

Before:
```
process.env.LINK_ENABLED = true;
```

After:
```
process.env.LINK_ENABLED = false;
```

To have homegames.link create a DNS record pointing to your local IP (mostly helpful for HTTPS, coming very soon), add:
process.env.AUTH_DIR = '/path/to/homegames/tokens'
process.env.LINK_DNS_ENABLED = true;

This requires a Homegames account (test.homegames.io). If these environment variables are set, the CLI will ask you to log in with your Homegames credentials, and then access/refresh tokens (NOT your password) will be stored in AUTH_DIR
