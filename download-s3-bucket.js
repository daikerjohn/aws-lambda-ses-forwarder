#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

const bucket = process.argv[2] || 'emailbucket-daikerjohncc';
const prefix = process.argv[3] || 'daikerjohncc';
const outputDir = process.argv[4] || './emails';

if (!bucket) {
  console.error('Usage: node download-s3-bucket.js <bucket> [prefix] [output-dir]');
  process.exit(1);
}

const client = new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2' });

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function downloadAll(bucketName, keyPrefix, destDir) {
  await ensureDir(destDir);

  let continuationToken;
  let count = 0;

  while (true) {
    const params = {
      Bucket: bucketName,
      Prefix: keyPrefix,
      ContinuationToken: continuationToken,
    };

    const response = await client.send(new ListObjectsV2Command(params));
    const objects = response.Contents || [];

    for (const object of objects) {
      if (!object.Key) continue;
      if (object.Key.endsWith('/')) continue;

      const relPath = object.Key.replace(/^\//, '');
      const targetPath = path.join(destDir, relPath);
      const targetDir = path.dirname(targetPath);
      await ensureDir(targetDir);

      const file = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: object.Key }));
      const body = await file.Body.transformToByteArray();
      await fs.promises.writeFile(targetPath, Buffer.from(body));
      count += 1;
      console.log(`Downloaded ${object.Key} -> ${targetPath}`);
    }

    if (!response.IsTruncated) break;
    continuationToken = response.NextContinuationToken;
  }

  console.log(`Finished downloading ${count} file(s) from s3://${bucketName}/${keyPrefix || ''}`);
}

downloadAll(bucket, prefix, outputDir).catch((err) => {
  console.error(err);
  process.exit(1);
});
