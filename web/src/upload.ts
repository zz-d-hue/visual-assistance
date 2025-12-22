import OSS from 'ali-oss';

export async function uploadToOss(blob: Blob): Promise<string> {
  const region = import.meta.env.VITE_OSS_REGION;
  const accessKeyId = import.meta.env.VITE_OSS_ACCESS_KEY_ID;
  const accessKeySecret = import.meta.env.VITE_OSS_ACCESS_KEY_SECRET;
  const bucket = import.meta.env.VITE_OSS_BUCKET;
  if (!region || !accessKeyId || !accessKeySecret || !bucket) {
    throw new Error('OSS not configured');
  }
  const client = new OSS({
    region,
    accessKeyId,
    accessKeySecret,
    stsToken: '',
    bucket
  });
  const ext = 'wav';
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2);
  const key = `audio/${ts}-${rand}.${ext}`;
  const result = await client.put(key, blob);
  const url = (result as any)?.url || (result as any)?.res?.requestUrls?.[0];
  console.log('upload result', result);
  if (!url) {
    throw new Error('upload failed');
  }
  return url;
}
