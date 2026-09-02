module.exports = {
  apps: [
    {
      name: "manhwa-api",
      cwd: "/root/projects/manhwa-backend",
      script: "app/main.py",
      interpreter: "/root/projects/manhwa-backend/.venv/bin/python",
      args: "--port 3000",
      instances: 1,
      autorestart: true,
      watch: false,
      kill_timeout: 30000,
      env: {
        ROLE: "api",
        PYTHONUNBUFFERED: "1",
        PYTHONPATH: "/root/projects/manhwa-backend",
        SECONDARY_PUBLIC_BASE: "https://11.shinigami.asia",
      },
    },
    {
      name: "manhwa-cron",
      cwd: "/root/projects/manhwa-backend",
      script: "app/main.py",
      interpreter: "/root/projects/manhwa-backend/.venv/bin/python",
      args: "--port 3001",
      instances: 1,
      autorestart: true,
      watch: false,
      kill_timeout: 30000,
      env: {
        ROLE: "cron",
        PYTHONUNBUFFERED: "1",
        PYTHONPATH: "/root/projects/manhwa-backend",
        SECONDARY_PUBLIC_BASE: "https://11.shinigami.asia",
      },
    },
  ],
};
