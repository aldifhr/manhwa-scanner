FROM node:22

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY . .

RUN pnpm install --no-frozen-lockfile

EXPOSE 3000
WORKDIR /app/apps/frontend
CMD ["pnpm", "start"]
