/**
 * 对象存储客户端（施工单 M8-04，§9）。S3 兼容，本地是 MinIO。
 *
 * # 网关只接收与转存，**不解析内容**（AC-09-8）
 *
 * 本文件里没有、也不该有任何解码/解析：不读 EXIF、不判图片真实尺寸、
 * 不解 PDF。图片理解归售后 Agent，PDF 解析归 RAGFlow。
 * 一旦网关开始解析，"上传通路"就变成了一个要跟着文件格式演进的东西。
 *
 * 相应地，类型判定只看**声明的 content-type + 大小**，不做内容嗅探——
 * 这在安全上是有代价的（用户可以声明一个假类型），但代价由下游承担：
 * 下游拿到的是句柄和声明类型，它自己决定信不信。
 * 网关替下游"验明正身"会引入一整套解析代码，正是这条红线要挡的。
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface StorageConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
}

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType?: string } | null>;
  remove(key: string): Promise<void>;
  /** 幂等建桶。首次启动时用。 */
  ensureBucket(): Promise<void>;
}

export function createObjectStore(cfg: StorageConfig): ObjectStore {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region ?? "us-east-1",
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // MinIO 不支持虚拟主机风格寻址（bucket.host），必须走 path-style。
    forcePathStyle: true,
  });

  return {
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
      }
    },

    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },

    async get(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
        const body = await r.Body?.transformToByteArray();
        return body ? { body, contentType: r.ContentType } : null;
      } catch {
        // 取不到与"不存在"在这里合并处理：调用方只需要知道拿不到。
        // 区分二者会诱导它去重试一个其实不存在的对象。
        return null;
      }
    },

    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },
  };
}
