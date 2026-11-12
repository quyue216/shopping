FROM node:22.22.0-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY public ./public
COPY docs ./docs
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
