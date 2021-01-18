another test
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
