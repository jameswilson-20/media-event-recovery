FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm install --omit=dev || true
ENV INFRAI_API_KEY=""
CMD ["node", "--experimental-strip-types", "src/index.ts"]
