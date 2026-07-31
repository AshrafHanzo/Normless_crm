#!/bin/bash
# Normless CRM — update/redeploy script (run on the VPS AFTER initial setup).
# Pulls latest code, installs deps, rebuilds the frontend, reloads PM2.
set -e

cd "$(dirname "$0")"

echo "📥 Pulling latest code..."
git pull origin main

echo "📦 Installing backend deps..."
npm install --omit=dev

echo "🔨 Building frontend..."
cd client
npm install
npm run build
cd ..

echo "🗄️  Ensuring DB schema is up to date..."
node server/db/init-postgres.js

echo "📋 Importing Crewfit orders from the sheet..."
node server/db/import-crewfit.js || echo "(crewfit import skipped)"

echo "♻️  Reloading app (zero-downtime)..."
pm2 reload ecosystem.config.js --update-env || pm2 start ecosystem.config.js
pm2 save

echo "✅ Deploy complete. Logs: pm2 logs normless-crm"
