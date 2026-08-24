/**
 * PM2 process definition for the production host.
 *
 * NODE_ENV=production is what makes src/config/env.config.ts load
 * `.env.production`, so it MUST be set here. Everything else (PORT, DB creds,
 * JWT secrets) is read from .env.production on the server.
 */
module.exports = {
  apps: [
    {
      name: "rakesetu-api",
      script: "dist/src/index.js",
      cwd: "/home/ubuntu/rakesetu-backend",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "600M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
