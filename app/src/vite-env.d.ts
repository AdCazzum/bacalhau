/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_UNISWAP_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
