# One image for every KoboFX process: the API, the worker, the migrations, the two simulated providers and the
# customer UI. compose.demo.yml picks the process with `command`.
#
# The `build` stage keeps the dev dependencies, so it also runs the repository's scripts on a server without Node:
#   docker build --target build -t kobofx:tools . && docker run --rm kobofx:tools npm run --silent secrets:generate

# argon2 compiles its native binding from source: the toolchain stays in the build stages only.
FROM node:20-bookworm-slim AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./

FROM toolchain AS build
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
# The image has no .git: the SHA /health reports comes from the build argument (scripts/stamp-build.js).
ARG BUILD_GIT_SHA=
ENV BUILD_GIT_SHA=${BUILD_GIT_SHA}
RUN npm run build

FROM toolchain AS production-dependencies
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY ui ./ui
USER node
CMD ["node", "dist/main.js"]
