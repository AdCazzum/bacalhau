/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in the public Cloudflare build; unset locally. */
  readonly VITE_PUBLIC_DEMO?: string;
  readonly VITE_GRAPH_API_KEY?: string;
  readonly VITE_GRAPH_SUBGRAPH_ID?: string;
  readonly VITE_GRAPH_SUBGRAPH_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
