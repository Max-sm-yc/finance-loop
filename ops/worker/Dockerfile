FROM node:22-alpine
RUN apk add --no-cache poppler-utils tesseract-ocr tesseract-ocr-data-eng
ENV NODE_ENV=production
WORKDIR /app
COPY src ./src
USER node
CMD ["node", "src/worker/run.mjs"]
