#!/bin/bash

# Normless CRM - Production Deployment Script
# Run this on your ServerByt server to deploy the app

echo "🚀 Starting Normless CRM Production Deployment..."

# Step 1: Navigate to app directory
cd /home/sites/3b/7b3d2b2433

# Step 2: Pull latest code (if using git)
# git pull origin main

# Step 3: Install dependencies
echo "📦 Installing dependencies..."
npm install --production

# Step 4: Build React frontend
echo "🔨 Building React frontend..."
cd client
npm install
npm run build
cd ..

# Step 5: Setup PM2 if not already installed
if ! command -v pm2 &> /dev/null; then
  echo "⚙️  Installing PM2..."
  npm install -g pm2
fi

# Step 6: Stop existing process
echo "🛑 Stopping existing process..."
pm2 stop normless-crm || true

# Step 7: Start app with PM2
echo "✅ Starting Normless CRM..."
pm2 start server/index.js --name "normless-crm" --instances 1

# Step 8: Save PM2 process list
pm2 save

# Step 9: Tell PM2 to restart on reboot
pm2 startup

echo "🎉 Deployment complete!"
echo "📊 View logs: pm2 logs normless-crm"
echo "⚙️  View status: pm2 status"
