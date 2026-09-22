# ---- IQ / Aptitude MCP server ----
FROM node:20-bookworm-slim

# poppler-utils provides pdftotext / pdftoppm / pdfimages for text + page-image extraction.
# tesseract-ocr (+ Arabic/English data) powers OCR of scanned / CamScanner PDFs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       poppler-utils tesseract-ocr tesseract-ocr-ara tesseract-ocr-eng ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package.json yarn.lock* ./
RUN yarn install --production=false --ignore-engines --frozen-lockfile || yarn install --ignore-engines

# Copy source.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public

# Persistent data (embeddings cache, images, registry) and sources live on volumes.
RUN mkdir -p /app/sources /app/data

ENV NODE_ENV=production \
    PORT=3000 \
    SOURCES_DIR=/app/sources \
    DATA_DIR=/app/data \
    TRANSFORMERS_CACHE=/app/data/models \
    OCR_ENABLED=true \
    OCR_LANGS=ara+eng \
    PRESENT_LANGUAGE=ar \
    WESTERN_DIGITS=true

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["yarn", "start"]
