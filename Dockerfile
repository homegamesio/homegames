FROM node:14

WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

RUN npm install
# If you are building your code for production
# RUN npm ci --only=production

COPY . .

# TODO: use port range from config
# homegames server sessions can take this port range currently
EXPOSE 7000-7100

RUN npm run build
CMD [ "npm", "start" ]
