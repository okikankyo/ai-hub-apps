// Durable file storage abstraction.
//
// In local development, files are kept under DATA_DIR/images. In Cloud Run,
// set GCS_BUCKET and the same file names are stored in Google Cloud Storage.
'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { DATA_DIR } = require('./db');

const IMAGES_DIR = path.join(DATA_DIR, 'images');
const BUCKET_NAME = process.env.GCS_BUCKET || '';
let bucket = null;

if (BUCKET_NAME) {
  // Google Application Default Credentials are used automatically on Cloud Run.
  const { Storage } = require('@google-cloud/storage');
  bucket = new Storage().bucket(BUCKET_NAME);
} else {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

function safeName(name) {
  if (!/^[a-f0-9]{16,32}\.(?:png|svg|jpg|jpeg|webp|gif)$/.test(String(name))) {
    throw new Error('invalid file name');
  }
  return String(name);
}

async function put(name, data, contentType) {
  name = safeName(name);
  if (!bucket) {
    await fsp.writeFile(path.join(IMAGES_DIR, name), data);
    return;
  }
  await bucket.file(`images/${name}`).save(data, {
    resumable: false,
    metadata: { contentType, cacheControl: 'private, max-age=86400' },
  });
}

async function get(name) {
  name = safeName(name);
  if (!bucket) return fsp.readFile(path.join(IMAGES_DIR, name));
  const [data] = await bucket.file(`images/${name}`).download();
  return data;
}

async function remove(name) {
  name = safeName(name);
  if (!bucket) {
    await fsp.unlink(path.join(IMAGES_DIR, name)).catch(() => {});
    return;
  }
  await bucket.file(`images/${name}`).delete({ ignoreNotFound: true });
}

module.exports = { IMAGES_DIR, BUCKET_NAME, put, get, remove };
