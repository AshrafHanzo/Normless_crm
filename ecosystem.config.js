module.exports = {
  apps: [
    {
      name: 'normless-crm',
      script: './server/index.js',
      cwd: __dirname,
      // fork (not cluster): the backend runs an in-process auto-sync timer,
      // so it must be a single instance to avoid duplicate Shopify syncs.
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 5000
      },
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_memory_restart: '600M'
    }
  ]
};
