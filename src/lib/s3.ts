import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Fail fast at import if any AWS config is missing — same convention as the
// RevenueCat webhook route. This is a pre-launch, controlled-env repo.
const region = process.env.AWS_REGION;
const bucket = process.env.AWS_S3_BUCKET;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
if (!region) throw new Error('AWS_REGION is not set');
if (!bucket) throw new Error('AWS_S3_BUCKET is not set');
if (!accessKeyId) throw new Error('AWS_ACCESS_KEY_ID is not set');
if (!secretAccessKey) throw new Error('AWS_SECRET_ACCESS_KEY is not set');

const s3Client = new S3Client({
  region,
  credentials: { accessKeyId, secretAccessKey },
});

// Allow-list of image content types the client may upload, mapped to the file
// extension baked into the S3 key. An unknown content type is rejected by the
// caller (400) — the key is server-constructed so the extension is trusted.
export const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

const UPLOAD_URL_TTL_SECONDS = 600; // ~10 min

const DOWNLOAD_URL_TTL_SECONDS = 900; // ~15 min

// Server-constructed, user-scoped key. The client never supplies the key or
// path — this is what makes ownership enforceable: a caller can only ever be
// handed keys under their own `{userId}/` prefix.
export function buildImageKey(userId: string, uuid: string, ext: string): string {
  return `note-images/${userId}/${uuid}.${ext}`;
}

export function createUploadUrl(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    s3Client,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS },
  );
}

export function createDownloadUrl(key: string): Promise<string> {
  return getSignedUrl(s3Client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: DOWNLOAD_URL_TTL_SECONDS,
  });
}

export async function deleteImageObject(key: string): Promise<void> {
  await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
