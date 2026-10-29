const express = require('express');
const cors = require('cors');
const env = require('./config/env');
const requestId = require('./middleware/requestId');
const errorHandler = require('./middleware/errorHandler');
const routes = require('./routes');

const app = express();

app.use(requestId);
// Rodada 4.1: was express.json() (100kb default). A batch of 50 items, each
// with its own 2200-char caption, can pass 100kb — 1mb keeps a wide margin.
app.use(express.json({ limit: '1mb' }));

// Only the configured frontend origin may call this API. No wildcard "*"
// in production - see section 22 of the project brief.
app.use(
  cors({
    origin: env.frontendUrl,
    credentials: true,
  })
);

app.use('/api', routes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' },
  });
});

app.use(errorHandler);

module.exports = app;