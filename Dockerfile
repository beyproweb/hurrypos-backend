FROM node:20-bullseye

# Install python + tesseract + language packs (Turkish + English)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip \
        tesseract-ocr tesseract-ocr-eng tesseract-ocr-tur \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Prevent large Chromium download from puppeteer during install
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install node deps
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copy app code
COPY . .

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

CMD ["node", "server.js"]
