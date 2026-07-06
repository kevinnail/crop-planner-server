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

// Hard cap on a single note image. The client declares the exact byte length up
// front; the route rejects anything larger, and the presigned PUT below binds
// that exact length so S3 refuses a body that doesn't match. A 12 MP capture at
// JPEG quality 0.85 lands around 2–5 MB, so 15 MiB is comfortable headroom.
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

// The per-user key prefix. Ownership of an s3_key means "starts with this" —
// used both to build server-constructed keys and to gate client-supplied keys
// on push/download. The trailing slash is load-bearing: it prevents one user id
// from prefix-matching another whose id shares a leading substring.
export function buildImageKeyPrefix(userId: string): string {
  return `note-images/${userId}/`;
}

// Server-constructed, user-scoped key. The client never supplies the key or
// path — this is what makes ownership enforceable: a caller can only ever be
// handed keys under their own `{userId}/` prefix.
export function buildImageKey(userId: string, uuid: string, ext: string): string {
  return `${buildImageKeyPrefix(userId)}${uuid}.${ext}`;
}

// `contentLength` is baked into the signature: adding `content-length` (and
// `content-type`) to `signableHeaders` makes S3 enforce them, so the client
// must PUT exactly `contentLength` bytes of exactly `contentType` — a mismatch
// is rejected with 403. Setting ContentLength on the command alone is NOT
// enough; a non-`x-amz-*` header is only enforced when it is signed.
export function createUploadUrl(
  key: string,
  contentType: string,
  contentLength: number,
): Promise<string> {
  return getSignedUrl(
    s3Client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    }),
    {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      signableHeaders: new Set(['content-length', 'content-type']),
    },
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
