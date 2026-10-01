FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY src ./src
CMD ["node", "src/worker/run.mjs"]
