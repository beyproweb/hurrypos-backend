FROM node:18-bullseye
# Install python + tesseract + language packs (Turkish + English)
FROM node:18-bullseye

# Install python + tesseract + language packs (Turkish + English)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip \
        tesseract-ocr tesseract-ocr-eng tesseract-ocr-tur \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Install node deps
COPY package*.json ./
RUN npm ci --omit=dev
# Copy app code
COPY . .
ENV NODE_ENV=production
ENV PORT=5000
EXPOSE 5000
CMD ["node", "server.js"]

WORKDIR /app

# Install node deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app code
COPY . .

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

CMD ["node", "server.js"]
