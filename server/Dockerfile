FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js reviewers.js gitlab.js ./

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

USER node
CMD ["node", "index.js"]
