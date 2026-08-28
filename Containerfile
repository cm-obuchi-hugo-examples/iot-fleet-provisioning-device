# Build stage: install development tools and compile TypeScript.
FROM node:24-bookworm-slim AS build

# All following build commands run relative to /app.
WORKDIR /app

# Node includes Corepack, which activates the pnpm version from package.json.
RUN corepack enable

# Copy dependency metadata first. Container builds can reuse the dependency
# layer when application source changes but package versions do not.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Copy only the compiler configuration and application source, then compile
# src/index.ts to dist/index.js. Remove development-only packages afterward.
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# Runtime stage: start again from a clean image so TypeScript and build tools
# are not included in the final IoT device image.
FROM node:24-bookworm-slim AS runtime

# Install Linux's public CA trust store for TLS server verification.
# AmazonRootCA1.pem can also be mounted explicitly when the container runs.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only the package metadata, production dependencies, and compiled
# JavaScript from the build stage. Claim and device keys are never copied.
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# Create mount targets for the persistent device identity and optional root CA.
# Claim credentials use /bootstrap, which Podman creates as a read-only mount.
RUN mkdir --parents /identity /trust \
    && chown node:node /identity /trust

# Do not run the IoT application as the root user.
USER node

# podman run starts the compiled Node.js device application automatically.
CMD ["node", "dist/index.js"]
