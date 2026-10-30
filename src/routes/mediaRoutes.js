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

// Rodada 7: library + folders. Declared before /:id so "folders" and
// "library" are never read as a media id.
router.get('/folders', asyncHandler(controller.listFolders));
router.post('/folders', asyncHandler(controller.createFolder));
router.patch('/folders/:id', asyncHandler(controller.renameFolder));
router.delete('/folders/:id', asyncHandler(controller.deleteFolder));
router.get('/library', asyncHandler(controller.listLibrary));
router.post('/library/bulk', asyncHandler(controller.libraryBulk));

router.get('/:id', asyncHandler(controller.getMedia));
router.delete('/:id', asyncHandler(controller.deleteMedia));

module.exports = router;