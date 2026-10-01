import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { errors } from "./errors";

/**
 * Object storage for doorstep evidence (POD photos).
 *
 * Uploads go straight from the rider's phone to the bucket on a presigned PUT —
 * a 2 MB JPEG never crosses the API server, and a dropped upload on 3G costs
 * the rider a retry, not a half-written request on our side.
 *
 * What the POD row stores is the object KEY (`s3:pod/…`), never a presigned
 * URL: those expire, and evidence must stay resolvable for as long as a COD
 * dispute can be raised.
 */

let client: S3Client | null = null;

function s3(): S3Client {
  if (!process.env.S3_ENDPOINT || !process.env.S3_BUCKET) {
    errors.upstream("Photo storage is not configured on this server.");
  }
  client ??= new S3Client({
    region: "auto",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: false,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    },
  });
  return client;
}

export const POD_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PodPhotoType = (typeof POD_PHOTO_TYPES)[number];

export async function presignPut(
  key: string,
  contentType: string,
  expiresInSeconds = 600,
): Promise<{ uploadUrl: string; storageRef: string; expiresInSeconds: number }> {
  const uploadUrl = await getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: expiresInSeconds },
  );
  return { uploadUrl, storageRef: `s3:${key}`, expiresInSeconds };
}
