# The Varde reference relay, room and matcher in one image.
# Pick the service with the command: `npm run relay`, `npm run room` or `npm run matcher`.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production VARDE_HOST=0.0.0.0 VARDE_HOME=/data
COPY package.json package-lock.json ./
# --ignore-scripts: the build step needs the sources, which are copied next.
RUN npm ci --omit=dev --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY spec ./spec
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
CMD ["npm", "run", "-s", "relay"]
