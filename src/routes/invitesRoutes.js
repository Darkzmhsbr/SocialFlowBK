const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/invitesController');

const router = Router();

router.use(requireAuth); // all invite endpoints are authenticated

router.post('/', asyncHandler(controller.create));
router.get('/', asyncHandler(controller.list));

module.exports = router;