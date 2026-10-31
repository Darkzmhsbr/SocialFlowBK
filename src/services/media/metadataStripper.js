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

// --- Rodada 20+ (Spoofer: Device + Brazil GPS + Hash Mutation) -------------

const DEVICE_PROFILES = [
  // iPhones (iOS)
  {
    os: 'IOS',
    make: 'Apple',
    model: 'iPhone 16 Pro Max',
    software: '18.1',
    lensModel: 'iPhone 16 Pro Max back triple camera 6.765mm f/1.78',
    focalLengthNum: 6765,
    focalLengthDen: 1000,
    fNumberNum: 178,
    fNumberDen: 100,
  },
  {
    os: 'IOS',
    make: 'Apple',
    model: 'iPhone 16 Pro',
    software: '18.0.1',
    lensModel: 'iPhone 16 Pro back triple camera 6.765mm f/1.78',
    focalLengthNum: 6765,
    focalLengthDen: 1000,
    fNumberNum: 178,
    fNumberDen: 100,
  },
  {
    os: 'IOS',
    make: 'Apple',
    model: 'iPhone 15 Pro Max',
    software: '17.6.1',
    lensModel: 'iPhone 15 Pro Max back triple camera 6.765mm f/1.78',
    focalLengthNum: 6765,
    focalLengthDen: 1000,
    fNumberNum: 178,
    fNumberDen: 100,
  },
  {
    os: 'IOS',
    make: 'Apple',
    model: 'iPhone 15 Pro',
    software: '17.5.1',
    lensModel: 'iPhone 15 Pro back triple camera 6.765mm f/1.78',
    focalLengthNum: 6765,
    focalLengthDen: 1000,
    fNumberNum: 178,
    fNumberDen: 100,
  },
  {
    os: 'IOS',
    make: 'Apple',
    model: 'iPhone 15',
    software: '17.5.1',
    lensModel: 'iPhone 15 back dual wide camera 5.96mm f/1.6',
    focalLengthNum: 596,
    focalLengthDen: 100,
    fNumberNum: 16,
    fNumberDen: 10,
  },
  {
    os: 'IOS',
    make: 'Apple',
    model: 'iPhone 14 Pro Max',
    software: '17.4.1',
    lensModel: 'iPhone 14 Pro Max back triple camera 6.86mm f/1.78',
    focalLengthNum: 686,
    focalLengthDen: 100,
    fNumberNum: 178,
    fNumberDen: 100,
  },
  {
    os: 'IOS',
    make: 'Apple',
    model: 'iPhone 14 Pro',
    software: '17.4.1',
    lensModel: 'iPhone 14 Pro back triple camera 6.86mm f/1.78',
    focalLengthNum: 686,
    focalLengthDen: 100,
    fNumberNum: 178,
    fNumberDen: 100,
  },
  {
    os: 'IOS',
    make: 'Apple',
    model: 'iPhone 13',
    software: '17.3.1',
    lensModel: 'iPhone 13 back dual wide camera 5.1mm f/1.6',
    focalLengthNum: 51,
    focalLengthDen: 10,
    fNumberNum: 16,
    fNumberDen: 10,
  },
  // Androids
  {
    os: 'ANDROID',
    make: 'samsung',
    model: 'SM-S928B', // Galaxy S24 Ultra
    commercialName: 'Galaxy S24 Ultra',
    software: 'S928BXXS3AXFE',
    lensModel: 'Samsung S24 Ultra Rear Main Camera 6.3mm f/1.7',
    focalLengthNum: 630,
    focalLengthDen: 100,
    fNumberNum: 17,
    fNumberDen: 10,
  },
  {
    os: 'ANDROID',
    make: 'samsung',
    model: 'SM-S918B', // Galaxy S23 Ultra
    commercialName: 'Galaxy S23 Ultra',
    software: 'S918BXXS5CXE2',
    lensModel: 'Samsung S23 Ultra Wide Camera 6.3mm f/1.7',
    focalLengthNum: 630,
    focalLengthDen: 100,
    fNumberNum: 17,
    fNumberDen: 10,
  },
  {
    os: 'ANDROID',
    make: 'samsung',
    model: 'SM-S921B', // Galaxy S24
    commercialName: 'Galaxy S24',
    software: 'S921BXXU2AXE4',
    lensModel: 'Samsung S24 Main Camera 5.4mm f/1.8',
    focalLengthNum: 540,
    focalLengthDen: 100,
    fNumberNum: 18,
    fNumberDen: 10,
  },
  {
    os: 'ANDROID',
    make: 'Xiaomi',
    model: '23127PN0CG', // Xiaomi 14
    commercialName: 'Xiaomi 14',
    software: 'OS1.0.9.0.UNCMIXM',
    lensModel: 'Leica Summilux 23mm f/1.6',
    focalLengthNum: 670,
    focalLengthDen: 100,
    fNumberNum: 16,
    fNumberDen: 10,
  },
  {
    os: 'ANDROID',
    make: 'motorola',
    model: 'XT2401-1', // Motorola Edge 50 Ultra
    commercialName: 'motorola edge 50 ultra',
    software: 'U3UV34.26-42',
    lensModel: 'Motorola 50MP OIS 6.1mm f/1.6',
    focalLengthNum: 610,
    focalLengthDen: 100,
    fNumberNum: 16,
    fNumberDen: 10,
  },
];

const BRAZIL_LOCATIONS = [
  // Sudeste
  { state: 'SP', city: 'São Paulo', lat: -23.5614, lon: -46.6559, alt: 760, tzOffset: '-03:00' },
  { state: 'SP', city: 'Campinas', lat: -22.9056, lon: -47.0608, alt: 685, tzOffset: '-03:00' },
  { state: 'SP', city: 'Santos', lat: -23.9618, lon: -46.3322, alt: 12, tzOffset: '-03:00' },
  { state: 'RJ', city: 'Rio de Janeiro', lat: -22.9711, lon: -43.1825, alt: 18, tzOffset: '-03:00' },
  { state: 'RJ', city: 'Niterói', lat: -22.8832, lon: -43.1034, alt: 15, tzOffset: '-03:00' },
  { state: 'MG', city: 'Belo Horizonte', lat: -19.9322, lon: -43.9381, alt: 852, tzOffset: '-03:00' },
  { state: 'MG', city: 'Uberlândia', lat: -18.9186, lon: -48.2772, alt: 863, tzOffset: '-03:00' },
  { state: 'ES', city: 'Vitória', lat: -20.3155, lon: -40.2958, alt: 14, tzOffset: '-03:00' },
  // Sul
  { state: 'SC', city: 'Florianópolis', lat: -27.5949, lon: -48.5482, alt: 15, tzOffset: '-03:00' },
  { state: 'SC', city: 'Balneário Camboriú', lat: -26.9926, lon: -48.6352, alt: 9, tzOffset: '-03:00' },
  { state: 'SC', city: 'Joinville', lat: -26.3045, lon: -48.8487, alt: 12, tzOffset: '-03:00' },
  { state: 'RS', city: 'Porto Alegre', lat: -30.0346, lon: -51.2177, alt: 22, tzOffset: '-03:00' },
  { state: 'RS', city: 'Gramado', lat: -29.3746, lon: -50.8764, alt: 830, tzOffset: '-03:00' },
  { state: 'PR', city: 'Curitiba', lat: -25.4284, lon: -49.2733, alt: 934, tzOffset: '-03:00' },
  { state: 'PR', city: 'Londrina', lat: -23.3045, lon: -51.1696, alt: 610, tzOffset: '-03:00' },
  // Centro-Oeste
  { state: 'DF', city: 'Brasília', lat: -15.7939, lon: -47.8828, alt: 1172, tzOffset: '-03:00' },
  { state: 'GO', city: 'Goiânia', lat: -16.6869, lon: -49.2648, alt: 749, tzOffset: '-03:00' },
  // Nordeste
  { state: 'BA', city: 'Salvador', lat: -12.9714, lon: -38.5014, alt: 45, tzOffset: '-03:00' },
  { state: 'PE', city: 'Recife', lat: -8.0578, lon: -34.8829, alt: 10, tzOffset: '-03:00' },
  { state: 'CE', city: 'Fortaleza', lat: -3.7319, lon: -38.5267, alt: 21, tzOffset: '-03:00' },
  // Norte
  { state: 'PA', city: 'Belém', lat: -1.4558, lon: -48.4902, alt: 14, tzOffset: '-03:00' },
  { state: 'AM', city: 'Manaus', lat: -3.1190, lon: -60.0217, alt: 92, tzOffset: '-04:00' },
];

function randomFloat(min, max) {
  const bytes = crypto.randomBytes(4).readUInt32BE(0);
  return min + (bytes / 0xffffffff) * (max - min);
}

function randomInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

function generateSpoofIdentity({ region, deviceBrand } = {}) {
  // 1. Pick device (filter by IOS/ANDROID if requested, else random)
  let pool = DEVICE_PROFILES;
  if (deviceBrand) {
    const norm = String(deviceBrand).toUpperCase().trim();
    if (norm === 'IPHONE' || norm === 'IOS' || norm === 'APPLE') {
      pool = DEVICE_PROFILES.filter((d) => d.os === 'IOS');
    } else if (norm === 'ANDROID') {
      pool = DEVICE_PROFILES.filter((d) => d.os === 'ANDROID');
    }
  }
  const device = pool[randomInt(0, pool.length - 1)] || DEVICE_PROFILES[0];

  // 2. Pick location in Brazil (filter by state/region if provided)
  let locPool = BRAZIL_LOCATIONS;
  if (region) {
    const normReg = String(region).toUpperCase().trim();
    const matched = BRAZIL_LOCATIONS.filter(
      (l) => l.state === normReg || l.city.toUpperCase() === normReg
    );
    if (matched.length > 0) locPool = matched;
  }
  const baseLoc = locPool[randomInt(0, locPool.length - 1)];

  // Apply realistic street-level GPS jitter (~100m to ~700m) + altitude variation
  const lat = Number((baseLoc.lat + randomFloat(-0.0065, 0.0065)).toFixed(6));
  const lon = Number((baseLoc.lon + randomFloat(-0.0065, 0.0065)).toFixed(6));
  const alt = Number(Math.max(2, baseLoc.alt + randomFloat(-4.5, 8.5)).toFixed(2));

  // 3. Generate realistic capture timestamp (between 15 mins and 36 hours ago)
  const offsetHours = baseLoc.tzOffset === '-04:00' ? -4 : -3;
  const captureInstant = new Date(Date.now() - randomInt(15 * 60 * 1000, 36 * 3600 * 1000));
  const localMs = captureInstant.getTime() + offsetHours * 3600 * 1000;
  const localDate = new Date(localMs);

  const pad2 = (n) => String(n).padStart(2, '0');
  const yyyy = localDate.getUTCFullYear();
  const mm = pad2(localDate.getUTCMonth() + 1);
  const dd = pad2(localDate.getUTCDate());
  const hh = pad2(localDate.getUTCHours());
  const mi = pad2(localDate.getUTCMinutes());
  const ss = pad2(localDate.getUTCSeconds());
  const subsec = String(randomInt(100, 999));

  const exifDateTime = `${yyyy}:${mm}:${dd} ${hh}:${mi}:${ss}`;
  const gpsDateStamp = `${captureInstant.getUTCFullYear()}:${pad2(captureInstant.getUTCMonth() + 1)}:${pad2(captureInstant.getUTCDate())}`;
  const gpsTimeHours = captureInstant.getUTCHours();
  const gpsTimeMinutes = captureInstant.getUTCMinutes();
  const gpsTimeSeconds = captureInstant.getUTCSeconds();

  const tzNoColon = baseLoc.tzOffset.replace(':', '');
  const appleCreationDate = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${tzNoColon}`;
  const isoCreationTime = captureInstant.toISOString().replace(/\.\d{3}Z$/, '.000000Z');

  // ISO-6709 string for MP4/MOV: e.g. "-23.5614-046.6559+0760.00/"
  const fmtCoord = (val, degDigits) => {
    const sign = val >= 0 ? '+' : '-';
    const abs = Math.abs(val).toFixed(4);
    const [intPart, decPart] = abs.split('.');
    return `${sign}${intPart.padStart(degDigits, '0')}.${decPart}`;
  };
  const fmtAlt = (val) => {
    const sign = val >= 0 ? '+' : '-';
    return `${sign}${Math.abs(val).toFixed(2).padStart(6, '0')}`;
  };
  const iso6709 = `${fmtCoord(lat, 2)}${fmtCoord(lon, 3)}${fmtAlt(alt)}/`;

  // Unique 32-hex Media/Image ID to guarantee unique cryptographic hash
  const uniqueMediaId = crypto.randomBytes(16).toString('hex');

  return {
    device,
    location: {
      state: baseLoc.state,
      city: baseLoc.city,
      lat,
      lon,
      alt,
      tzOffset: baseLoc.tzOffset,
      iso6709,
    },
    timestamps: {
      exifDateTime,
      subsec,
      gpsDateStamp,
      gpsTimeHours,
      gpsTimeMinutes,
      gpsTimeSeconds,
      appleCreationDate,
      isoCreationTime,
    },
    uniqueMediaId,
  };
}

function degToDmsRationals(decimalDegrees) {
  const abs = Math.abs(decimalDegrees);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const secHundredths = Math.round((minFloat - min) * 60 * 100);
  return [
    [deg, 1],
    [min, 1],
    [secHundredths, 100],
  ];
}

/**
 * Builds a complete big-endian TIFF structure containing IFD0, ExifIFD and GPSIFD.
 * Used by both JPEG (APP1) and PNG (eXIf chunk).
 */
function buildSpoofedTiffBuffer(orientation, identity) {
  const { device, location, timestamps, uniqueMediaId } = identity;
  const orientVal = orientation >= 1 && orientation <= 8 ? orientation : 1;

  // Helper to build an IFD table and serialize overflow values (> 4 bytes)
  function packIfd(entries, startOffset, nextIfdOffset = 0) {
    // Sort by tag ascending as required by the TIFF 6.0 / EXIF spec
    const sorted = [...entries].sort((a, b) => a.tag - b.tag);
    const dirSize = 2 + sorted.length * 12 + 4;
    let dataOffset = startOffset + dirSize;
    const dirBuf = Buffer.alloc(dirSize);
    dirBuf.writeUInt16BE(sorted.length, 0);

    const dataChunks = [];
    sorted.forEach((entry, idx) => {
      const pos = 2 + idx * 12;
      dirBuf.writeUInt16BE(entry.tag, pos);
      dirBuf.writeUInt16BE(entry.type, pos + 2);
      dirBuf.writeUInt32BE(entry.count, pos + 4);

      if (entry.rawBytes.length <= 4) {
        const inline = Buffer.alloc(4);
        entry.rawBytes.copy(inline, 0);
        inline.copy(dirBuf, pos + 8);
      } else {
        dirBuf.writeUInt32BE(dataOffset, pos + 8);
        // Word-align (even byte boundary) for TIFF compliance
        const pad = entry.rawBytes.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
        dataChunks.push(entry.rawBytes, pad);
        dataOffset += entry.rawBytes.length + pad.length;
      }
    });

    dirBuf.writeUInt32BE(nextIfdOffset, 2 + sorted.length * 12);
    return {
      buffer: Buffer.concat([dirBuf, ...dataChunks]),
      endOffset: dataOffset,
    };
  }

  const asciiEntry = (tag, str) => {
    const raw = Buffer.from(`${str}\0`, 'latin1');
    return { tag, type: 2, count: raw.length, rawBytes: raw };
  };
  const shortEntry = (tag, val) => {
    const raw = Buffer.alloc(2);
    raw.writeUInt16BE(val, 0);
    return { tag, type: 3, count: 1, rawBytes: raw };
  };
  const longEntry = (tag, val) => {
    const raw = Buffer.alloc(4);
    raw.writeUInt32BE(val, 0);
    return { tag, type: 4, count: 1, rawBytes: raw };
  };
  const rationalEntry = (tag, pairs) => {
    const raw = Buffer.alloc(pairs.length * 8);
    pairs.forEach(([num, den], i) => {
      raw.writeUInt32BE(num >>> 0, i * 8);
      raw.writeUInt32BE(den >>> 0, i * 8 + 4);
    });
    return { tag, type: 5, count: pairs.length, rawBytes: raw };
  };
  const undefEntry = (tag, bytes) => ({
    tag,
    type: 7,
    count: bytes.length,
    rawBytes: Buffer.from(bytes),
  });
  const byteEntry = (tag, bytes) => ({
    tag,
    type: 1,
    count: bytes.length,
    rawBytes: Buffer.from(bytes),
  });

  // 1. Prepare ExifIFD entries
  const exifEntries = [
    rationalEntry(0x829d, [[device.fNumberNum, device.fNumberDen]]), // FNumber
    undefEntry(0x9000, Buffer.from('0232', 'latin1')), // ExifVersion 2.32
    asciiEntry(0x9003, timestamps.exifDateTime), // DateTimeOriginal
    asciiEntry(0x9004, timestamps.exifDateTime), // DateTimeDigitized
    asciiEntry(0x9010, location.tzOffset), // OffsetTime
    asciiEntry(0x9011, location.tzOffset), // OffsetTimeOriginal
    asciiEntry(0x9291, timestamps.subsec), // SubSecTimeOriginal
    asciiEntry(0x9292, timestamps.subsec), // SubSecTimeDigitized
    rationalEntry(0x920a, [[device.focalLengthNum, device.focalLengthDen]]), // FocalLength
    shortEntry(0xa001, 1), // ColorSpace = sRGB
    asciiEntry(0xa420, uniqueMediaId), // ImageUniqueID (guarantees hash mutation)
    asciiEntry(0xa433, device.make), // LensMake
    asciiEntry(0xa434, device.lensModel), // LensModel
  ];

  // 2. Prepare GPSIFD entries
  const latDms = degToDmsRationals(location.lat);
  const lonDms = degToDmsRationals(location.lon);
  const altCentimeters = Math.round(Math.abs(location.alt) * 100);

  const gpsEntries = [
    byteEntry(0x0000, [2, 3, 0, 0]), // GPSVersionID
    asciiEntry(0x0001, location.lat >= 0 ? 'N' : 'S'), // GPSLatitudeRef
    rationalEntry(0x0002, latDms), // GPSLatitude
    asciiEntry(0x0003, location.lon >= 0 ? 'E' : 'W'), // GPSLongitudeRef
    rationalEntry(0x0004, lonDms), // GPSLongitude
    byteEntry(0x0005, [0]), // GPSAltitudeRef (above sea level)
    rationalEntry(0x0006, [[altCentimeters, 100]]), // GPSAltitude
    rationalEntry(0x0007, [
      [timestamps.gpsTimeHours, 1],
      [timestamps.gpsTimeMinutes, 1],
      [timestamps.gpsTimeSeconds, 1],
    ]), // GPSTimeStamp
    asciiEntry(0x001d, timestamps.gpsDateStamp), // GPSDateStamp
  ];

  // 3. First pass on IFD0 to know exact offsets for ExifIFD and GPSIFD
  const ifd0BaseEntries = [
    asciiEntry(0x010f, device.make), // Make
    asciiEntry(0x0110, device.model), // Model
    shortEntry(0x0112, orientVal), // Orientation
    rationalEntry(0x011a, [[72, 1]]), // XResolution
    rationalEntry(0x011b, [[72, 1]]), // YResolution
    shortEntry(0x0128, 2), // ResolutionUnit (inches)
    asciiEntry(0x0131, device.software), // Software
    asciiEntry(0x0132, timestamps.exifDateTime), // DateTime
  ];

  const dummyIfd0 = packIfd(
    [...ifd0BaseEntries, longEntry(0x8769, 0), longEntry(0x8825, 0)],
    8,
    0
  );
  const exifIfdOffset = dummyIfd0.endOffset;
  const packedExif = packIfd(exifEntries, exifIfdOffset, 0);
  const gpsIfdOffset = packedExif.endOffset;
  const packedGps = packIfd(gpsEntries, gpsIfdOffset, 0);

  // Final IFD0 with real offsets
  const packedIfd0 = packIfd(
    [
      ...ifd0BaseEntries,
      longEntry(0x8769, exifIfdOffset), // ExifOffset
      longEntry(0x8825, gpsIfdOffset), // GPSInfo
    ],
    8,
    0
  );

  const tiffHeader = Buffer.alloc(8);
  tiffHeader.write('MM', 0, 'latin1'); // Big-endian
  tiffHeader.writeUInt16BE(42, 2);
  tiffHeader.writeUInt32BE(8, 4);

  return Buffer.concat([tiffHeader, packedIfd0.buffer, packedExif.buffer, packedGps.buffer]);
}

function buildSpoofedJpegApp1(orientation, identity) {
  const tiff = buildSpoofedTiffBuffer(orientation, identity);
  const exifHeader = Buffer.from('Exif\0\0', 'latin1');
  const body = Buffer.concat([exifHeader, tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

// CRC32 table for PNG chunk integrity
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildPngChunk(typeStr, dataBuf) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuf.length, 0);
  const typeBuf = Buffer.from(typeStr, 'latin1');
  const crcVal = crc32(Buffer.concat([typeBuf, dataBuf]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);
  return Buffer.concat([lenBuf, typeBuf, dataBuf, crcBuf]);
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

function stripJpeg(buf, identity = null) {
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
  const activeIdentity = identity || generateSpoofIdentity();
  if (activeIdentity) {
    out.splice(1, 0, buildSpoofedJpegApp1(orientation || 1, activeIdentity));
  } else if (orientation && orientation !== 1) {
    out.splice(1, 0, orientationOnlyExif(orientation));
  }
  const result = Buffer.concat(out);
  return { buffer: result, removed: [...removed], spoofed: activeIdentity };
}

// --- PNG -------------------------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function stripPng(buf, identity = null) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const out = [PNG_SIG];
  const removed = new Set();
  const activeIdentity = identity || generateSpoofIdentity();
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) return null;
    if (PNG_DROP.has(type)) {
      removed.add(type);
    } else if (type === 'IEND') {
      if (activeIdentity) {
        const tiffPayload = buildSpoofedTiffBuffer(1, activeIdentity);
        out.push(buildPngChunk('eXIf', tiffPayload));
      }
      out.push(buf.subarray(i, end));
    } else {
      out.push(buf.subarray(i, end));
    }
    i = end;
    if (type === 'IEND') break;
  }
  return { buffer: Buffer.concat(out), removed: [...removed], spoofed: activeIdentity };
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

async function stripVideo(buf, mimetype, identity = null) {
  const format = mimetype === 'video/quicktime' ? 'mov' : 'mp4';
  const activeIdentity = identity || generateSpoofIdentity();
  const { device, location, timestamps, uniqueMediaId } = activeIdentity;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-meta-'));
  const id = crypto.randomBytes(6).toString('hex');
  const input = path.join(dir, `in-${id}.${format}`);
  const output = path.join(dir, `out-${id}.${format}`);
  try {
    await fs.writeFile(input, buf);

    const metadataArgs = [
      '-metadata', `creation_time=${timestamps.isoCreationTime}`,
      '-metadata', `location=${location.iso6709}`,
      '-metadata', `location-por=${location.iso6709}`,
      '-metadata', `location-eng=${location.iso6709}`,
      '-metadata', `make=${device.make}`,
      '-metadata', `model=${device.model}`,
      '-metadata', `com.apple.quicktime.make=${device.make}`,
      '-metadata', `com.apple.quicktime.model=${device.model}`,
      '-metadata', `com.apple.quicktime.software=${device.software}`,
      '-metadata', `com.apple.quicktime.creationdate=${timestamps.appleCreationDate}`,
      '-metadata', `com.apple.quicktime.location.ISO6709=${location.iso6709}`,
      '-metadata', `com.apple.quicktime.content.identifier=${uniqueMediaId}`,
      '-metadata', `comment=${uniqueMediaId}`,
    ];

    if (device.os === 'ANDROID') {
      metadataArgs.push(
        '-metadata', `com.android.manufacturer=${device.make}`,
        '-metadata', `com.android.model=${device.model}`,
        '-metadata', `com.android.version=14`
      );
    }

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
      ...metadataArgs,
      '-movflags', '+faststart+use_metadata_tags',
      '-f', format,
      output,
    ]);
    const result = await fs.readFile(output);
    if (result.length < 1024) throw new Error('arquivo de saída vazio');
    return { buffer: result, removed: ['metadados do vídeo'], spoofed: activeIdentity };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- Public ----------------------------------------------------------------

/**
 * @param {{ buffer: Buffer, mimetype: string, region?: string, deviceBrand?: string }} file
 * @returns {Promise<{ buffer: Buffer, stripped: boolean, removed: string[], spoofed?: object }>}
 */
async function stripMetadata({ buffer, mimetype, region, deviceBrand }) {
  try {
    const identity = generateSpoofIdentity({ region, deviceBrand });
    let result = null;
    if (mimetype === 'image/jpeg' || mimetype === 'image/jpg') result = stripJpeg(buffer, identity);
    else if (mimetype === 'image/png') result = stripPng(buffer, identity);
    else if (mimetype === 'video/mp4' || mimetype === 'video/quicktime') result = await stripVideo(buffer, mimetype, identity);
    if (!result) return { buffer, stripped: false, removed: [], spoofed: null };
    return {
      buffer: result.buffer,
      stripped: true,
      removed: result.removed,
      spoofed: result.spoofed
        ? {
            os: result.spoofed.device.os,
            make: result.spoofed.device.make,
            model: result.spoofed.device.commercialName || result.spoofed.device.model,
            rawModel: result.spoofed.device.model,
            software: result.spoofed.device.software,
            city: result.spoofed.location.city,
            state: result.spoofed.location.state,
            lat: result.spoofed.location.lat,
            lon: result.spoofed.location.lon,
            uniqueMediaId: result.spoofed.uniqueMediaId,
          }
        : null,
    };
  } catch (err) {
    logger.warn('Metadata strip failed, keeping original file', { mimetype, error: err.message.slice(0, 300) });
    return { buffer, stripped: false, removed: [], spoofed: null };
  }
}

module.exports = { stripMetadata, stripJpeg, stripPng, stripVideo, generateSpoofIdentity };