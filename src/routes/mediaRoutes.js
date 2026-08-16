const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const { singleUpload } = require('../middleware/uploadHandler');
const controller = require('../controllers/mediaController');

const router = Router();

router.use(requireAuth); // every media endpoint requires authentication

// The frontend sends the file under the form field "file".
router.post('/upload', singleUpload('file'), asyncHandler(controller.uploadMedia));

router.get('/', asyncHandler(controller.listMedia));
router.get('/:id', asyncHandler(controller.getMedia));
router.delete('/:id', asyncHandler(controller.deleteMedia));

module.exports = router;