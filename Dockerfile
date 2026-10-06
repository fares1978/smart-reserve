# Version must match the "playwright" dependency in package.json.
FROM mcr.microsoft.com/playwright:v1.48.2-jammy

# Xvfb + x11vnc + noVNC give staff a live view of the (headed) browser when a
# CAPTCHA needs a human click. Only used when LIVE_VIEW_URL is set.
RUN DEBIAN_FRONTEND=noninteractive TZ=Europe/Moscow apt-get update && \
    DEBIAN_FRONTEND=noninteractive TZ=Europe/Moscow apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY docker/start.sh /start.sh
RUN chmod +x /start.sh

ENV PROFILE_DIR=/data/profile DATA_DIR=/data HEADLESS=true
VOLUME /data
EXPOSE 3100 6080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["/start.sh"]
