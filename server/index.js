const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');

// Load .env from the root directory
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Auth middleware
const authMiddleware = require('./middleware/auth');

// Routes
const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customers');
const orderRoutes = require('./routes/orders');
const interactionRoutes = require('./routes/interactions');
const dashboardRoutes = require('./routes/dashboard');
const syncRoutes = require('./routes/sync');

// Public routes
app.use('/api/auth', authRoutes);

// Protected routes
app.use('/api/customers', authMiddleware, customerRoutes);
app.use('/api/orders', authMiddleware, orderRoutes);
app.use('/api/interactions', authMiddleware, interactionRoutes);
app.use('/api/dashboard', authMiddleware, dashboardRoutes);
app.use('/api/sync', authMiddleware, syncRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Normless CRM Backend is running!' });
});

// Serve React frontend in production
const clientBuildPath = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientBuildPath));

// Catch-all for SPA routing - send index.html for non-API routes
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(clientBuildPath, 'index.html'), (err) => {
      if (err) next();
    });
  } else {
    next();
  }
});

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Normless CRM Backend running on http://localhost:${PORT}`);
});
