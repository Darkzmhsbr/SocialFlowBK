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

module.exports = router;