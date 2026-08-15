const { PrismaClient } = require('@prisma/client');

// A single shared Prisma instance. Importing this file anywhere in the app
// reuses the same connection pool instead of opening a new one per request.
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

module.exports = prisma;
