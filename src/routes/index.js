const { Router } = require('express');
const healthRoutes = require('./healthRoutes');
const instagramRoutes = require('./instagramRoutes');

const router = Router();

router.use('/', healthRoutes); // -> /api/health
router.use('/instagram', instagramRoutes); // -> /api/instagram/*

module.exports = router;
