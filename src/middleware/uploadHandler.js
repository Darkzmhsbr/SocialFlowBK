// Multer middleware for parsing a single-file multipart/form-data upload
// into req.file (a Buffer in memory). Memory storage is intentional: we
// never write user uploads to Railway's ephemeral disk - the buffer goes
// straight to Cloudinary and is garbage-collected.
//
// Fine-grained validation (dimensions, aspect ratio, video codec) happens
// later in mediaService, once Cloudinary has parsed the file and returned
// its metadata. This middleware only guards the cheap, upfront rules.

const multer = require('multer');
const env = require('../config/env');
const { AppError, ErrorCodes } = require('../utils/errors');

const storage = multer.memoryStorage();

// The hard upper bound multer will enforce. We use the video limit here
// because it's the larger of the two; per-type limits (image vs video)
// are re-checked inside mediaService once we know what was uploaded.
const HARD_LIMIT_BYTES = Math.max(
  env.uploads.maxImageBytes,
  env.uploads.maxVideoBytes
);

const ALLOWED_MIMES = new Set([
  ...env.uploads.allowedImageMimes,
  ...env.uploads.allowedVideoMimes,
]);

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIMES.has(file.mimetype)) {
    return cb(
      new AppError(
        ErrorCodes.INVALID_MEDIA_TYPE,
        `Tipo de arquivo não suportado (${file.mimetype}). Envie JPG, PNG, MP4 ou MOV.`,
        400
      )
    );
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: HARD_LIMIT_BYTES,
    files: 1, // single-file upload; carousels upload one file per request
  },
});

// Wraps multer.single so its own errors (e.g. LIMIT_FILE_SIZE) get
// translated into AppError before hitting the global errorHandler.
function singleUpload(fieldName) {
  const inner = upload.single(fieldName);
  return (req, res, next) => {
    inner(req, res, (err) => {
      if (!err) return next();
      if (err instanceof AppError) return next(err);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(
          new AppError(
            ErrorCodes.MEDIA_TOO_LARGE,
            'Arquivo maior que o limite permitido.',
            413
          )
        );
      }
      return next(
        new AppError(ErrorCodes.UPLOAD_FAILED, 'Falha ao processar o upload.', 400, {
          multer: err.message,
        })
      );
    });
  };
}

module.exports = { singleUpload };