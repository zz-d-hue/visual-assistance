type Det = {
  bbox: [number, number, number, number];
  label?: string;
  class?: string;
  score?: number;
};

interface ImportMetaEnv {
  readonly VITE_OSS_REGION?: string;
  readonly VITE_OSS_ACCESS_KEY_ID?: string;
  readonly VITE_OSS_ACCESS_KEY_SECRET?: string;
  readonly VITE_OSS_SECURITY_TOKEN?: string;
  readonly VITE_OSS_BUCKET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
