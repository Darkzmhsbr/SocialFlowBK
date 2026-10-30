const { Router } = require('express');
const healthRoutes = require('./healthRoutes');
const instagramRoutes = require('./instagramRoutes');
const setupRoutes = require('./setupRoutes');
const mediaRoutes = require('./mediaRoutes');
const postsRoutes = require('./postsRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const authRoutes = require('./authRoutes');
const invitesRoutes = require('./invitesRoutes');
// Rodada 5
const notificationsRoutes = require('./notificationsRoutes');
// Rodada 11
const adminRoutes = require('./adminRoutes');
// Rodada 12
const cleanupRoutes = require('./cleanupRoutes');
// Rodada 13
const metricsRoutes = require('./metricsRoutes');
// Rodada 16
const templatesRoutes = require('./templatesRoutes');
// Rodada 17
const monitoringRoutes = require('./monitoringRoutes');
const telegramRoutes = require('./telegramRoutes');
// Rodada 18
const performanceRoutes = require('./performanceRoutes');

const router = Router();

router.use('/', healthRoutes); // -> /api/health
router.use('/instagram', instagramRoutes); // -> /api/instagram/*
router.use('/setup', setupRoutes); // -> /api/setup/*
router.use('/media', mediaRoutes); // -> /api/media/*
router.use('/posts', postsRoutes); // -> /api/posts/*
router.use('/dashboard', dashboardRoutes); // -> /api/dashboard/*
router.use('/auth', authRoutes); // -> /api/auth/*
router.use('/invites', invitesRoutes); // -> /api/invites/*
router.use('/notifications', notificationsRoutes); // -> /api/notifications/* (Rodada 5)
router.use('/admin', adminRoutes); // -> /api/admin/* (Rodada 11)
router.use('/cleanup', cleanupRoutes); // -> /api/cleanup/* (Rodada 12)
router.use('/metrics', metricsRoutes); // -> /api/metrics/* (Rodada 13)
router.use('/templates', templatesRoutes); // -> /api/templates/* (Rodada 16)
router.use('/monitoring', monitoringRoutes); // -> /api/monitoring/* (Rodada 17)
router.use('/telegram', telegramRoutes); // -> /api/telegram/* (Rodada 17)
router.use('/performance', performanceRoutes); // -> /api/performance/* (Rodada 18)

module.exports = router;