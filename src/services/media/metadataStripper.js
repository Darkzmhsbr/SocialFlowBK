// Rodada 20: remove private metadata from uploaded media (privacy).
//
// Photos and videos taken on a phone can carry the GPS position where they
// were made, the phone model, the date and other personal data. Uploaded
// files live on public URLs, so we drop all of it before storing.
//
// Nothing is re-encoded: the image/video data stays byte-for-byte the same
// (no quality loss). Only metadata blocks are removed.
//   JPEG: drops EXIF/XMP/IPTC/comments. If the photo depends on the EXIF
//         rotation flag, a tiny EXIF block with ONLY that flag is kept, so
//         the photo is not shown sideways.
//   PNG:  drops text/EXIF/time chunks.
//   MP4/MOV: ffmpeg stream copy without metadata/chapters/data tracks
//         (iPhone location tracks included). The rotation of the video is
//         kept (it is not metadata, it is part of the video track).
//
// Never blocks an upload: if anything fails, the original file is used
// and a warning is logged.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const logger = require('../../utils/logger');

const FFMPEG_TIMEOUT_MS = 3 * 60 * 1000;

// ffmpeg-static ships its own binary (npm install). Falls back to the
// system ffmpeg when the package is missing.
function ffmpegPath() {
  try {
    // eslint-disable-next-line global-require
    const p = require('ffmpeg-static');
    if (p) return p;
  } catch (_) {
    /* not installed */
  }
  return 'ffmpeg';
}

// --- JPEG ------------------------------------------------------------------

const JPEG_KEEP_APP = new Set([0xe0, 0xee]); // APP0 (JFIF), APP14 (Adobe color info)

function readExifOrientation(seg) {
  // seg = APP1 payload (after the 2 length bytes)
  if (seg.length < 14 || seg.toString('latin1', 0, 6) !== 'Exif\0\0') return null;
  const tiff = seg.subarray(6);
  const le = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  try {
    const ifd = u32(4);
    const count = u16(ifd);
    for (let i = 0; i < count; i += 1) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === 0x0112) {
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : null;
      }
    }
  } catch (_) {
    return null;
  }
  return null;
}

function orientationOnlyExif(value) {
  // "Exif\0\0" + TIFF (big endian) with one IFD entry: Orientation (SHORT)
  const body = Buffer.alloc(6 + 8 + 2 + 12 + 4);
  body.write('Exif\0\0', 0, 'latin1');
  body.write('MM', 6, 'latin1');
  body.writeUInt16BE(42, 8);
  body.writeUInt32BE(8, 10);
  body.writeUInt16BE(1, 14);
  body.writeUInt16BE(0x0112, 16);
  body.writeUInt16BE(3, 18);
  body.writeUInt32BE(1, 20);
  body.writeUInt16BE(value, 24);
  body.writeUInt32BE(0, 28);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

function stripJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out = [buf.subarray(0, 2)];
  const removed = new Set();
  let orientation = null;
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null; // not a marker where one was expected
    let marker = buf[i + 1];
    while (marker === 0xff) {
      i += 1;
      marker = buf[i + 1];
    }
    if (marker === 0xd9) {
      out.push(buf.subarray(i, i + 2));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    const end = i + 2 + len;
    if (end > buf.length) return null;
    const payload = buf.subarray(i + 4, end);

    if (marker === 0xda) {
      // Start of scan: copy it and the compressed data up to the end of the
      // image (FFD9). Inside the data, 0xFF is always followed by 0x00 or a
      // restart marker, so the first real FFD9 is the end of THIS picture.
      // Anything after it (embedded previews with their own EXIF) is dropped.
      let j = end;
      while (j < buf.length - 1 && !(buf[j] === 0xff && buf[j + 1] === 0xd9)) j += 1;
      out.push(buf.subarray(i, Math.min(j + 2, buf.length)));
      break;
    }

    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (isApp || marker === 0xfe) {
      const keepIcc = marker === 0xe2 && payload.toString('latin1', 0, 12) === 'ICC_PROFILE\0';
      if (JPEG_KEEP_APP.has(marker) || keepIcc) {
        out.push(buf.subarray(i, end));
      } else {
        if (marker === 0xe1 && orientation === null) orientation = readExifOrientation(payload);
        removed.add(marker === 0xfe ? 'comentário' : marker === 0xe1 ? 'EXIF/XMP' : marker === 0xed ? 'IPTC' : 'APP');
      }
    } else {
      out.push(buf.subarray(i, end));
    }
    i = end;
  }
  if (orientation && orientation !== 1) out.splice(1, 0, orientationOnlyExif(orientation));
  const result = Buffer.concat(out);
  return { buffer: result, removed: [...removed] };
}

// --- PNG -------------------------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function stripPng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const out = [PNG_SIG];
  const removed = new Set();
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) return null;
    if (PNG_DROP.has(type)) removed.add(type);
    else out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return { buffer: Buffer.concat(out), removed: [...removed] };
}

// --- Video -----------------------------------------------------------------

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${err.message}\n${String(stderr || '').slice(-600)}`;
        return reject(err);
      }
      return resolve();
    });
  });
}

async function stripVideo(buf, mimetype) {
  const format = mimetype === 'video/quicktime' ? 'mov' : 'mp4';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-meta-'));
  const id = crypto.randomBytes(6).toString('hex');
  const input = path.join(dir, `in-${id}.${format}`);
  const output = path.join(dir, `out-${id}.${format}`);
  try {
    await fs.writeFile(input, buf);
    await run(ffmpegPath(), [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', input,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c', 'copy',
      '-map_metadata', '-1',
      '-map_metadata:s:v', '-1',
      '-map_metadata:s:a', '-1',
      '-map_chapters', '-1',
      '-fflags', '+bitexact',
      '-flags:v', '+bitexact',
      '-flags:a', '+bitexact',
      '-movflags', '+faststart',
      '-f', format,
      output,
    ]);
    const result = await fs.readFile(output);
    if (result.length < 1024) throw new Error('arquivo de saída vazio');
    return { buffer: result, removed: ['metadados do vídeo'] };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- Public ----------------------------------------------------------------

/**
 * @param {{ buffer: Buffer, mimetype: string }} file
 * @returns {Promise<{ buffer: Buffer, stripped: boolean, removed: string[] }>}
 */
async function stripMetadata({ buffer, mimetype }) {
  try {
    let result = null;
    if (mimetype === 'image/jpeg' || mimetype === 'image/jpg') result = stripJpeg(buffer);
    else if (mimetype === 'image/png') result = stripPng(buffer);
    else if (mimetype === 'video/mp4' || mimetype === 'video/quicktime') result = await stripVideo(buffer, mimetype);
    if (!result) return { buffer, stripped: false, removed: [] };
    return { buffer: result.buffer, stripped: true, removed: result.removed };
  } catch (err) {
    logger.warn('Metadata strip failed, keeping original file', { mimetype, error: err.message.slice(0, 300) });
    return { buffer, stripped: false, removed: [] };
  }
}

module.exports = { stripMetadata, stripJpeg, stripPng, stripVideo };