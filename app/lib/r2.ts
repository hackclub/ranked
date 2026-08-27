import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { RECORDING_UPLOAD_URL_TTL_SECONDS } from "@/app/lib/recording-policy";

let cachedClient: S3Client | null = null;

const RECORDING_STORAGE_ENV = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_RECORDINGS_BUCKET",
] as const;

export function recordingStorageConfigured() {
  return RECORDING_STORAGE_ENV.every((name) => process.env[name]?.trim());
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export function recordingBucketName() {
  return required("R2_RECORDINGS_BUCKET");
}

export function recordingR2() {
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: "auto",
      endpoint: `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: required("R2_ACCESS_KEY_ID"),
        secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
      },
    });
  }
  return cachedClient;
}

export async function signedRecordingUploadUrl(key: string, contentType: string) {
  return getSignedUrl(
    recordingR2(),
    new PutObjectCommand({
      Bucket: recordingBucketName(),
      Key: key,
      ContentType: contentType,
      CacheControl: "private, no-store",
    }),
    { expiresIn: RECORDING_UPLOAD_URL_TTL_SECONDS },
  );
}

export async function headRecordingObject(key: string) {
  return recordingR2().send(
    new HeadObjectCommand({ Bucket: recordingBucketName(), Key: key }),
  );
}

export async function getRecordingObject(key: string, range?: string | null) {
  return recordingR2().send(
    new GetObjectCommand({
      Bucket: recordingBucketName(),
      Key: key,
      Range: range || undefined,
    }),
  );
}

export async function deleteRecordingObjects(keys: string[]) {
  for (let offset = 0; offset < keys.length; offset += 1_000) {
    const batch = keys.slice(offset, offset + 1_000);
    if (!batch.length) continue;
    const result = await recordingR2().send(
      new DeleteObjectsCommand({
        Bucket: recordingBucketName(),
        Delete: {
          Quiet: true,
          Objects: batch.map((Key) => ({ Key })),
        },
      }),
    );
    if (result.Errors?.length) {
      throw new Error(`R2 refused to delete ${result.Errors.length} recording objects.`);
    }
  }
}
