module.exports = {
  apps: [
    {
      name: 'normless-crm',
      script: './server/index.js',
      instances: 1,
      exec_mode: 'cluster',
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
      max_memory_restart: '500M',
      ignore_watch: ['node_modules', 'client/dist', 'logs'],
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};
