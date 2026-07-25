/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_UNISWAP_API_KEY?: string;
  readonly VITE_GRAPH_API_KEY?: string;
  readonly VITE_GRAPH_SUBGRAPH_ID?: string;
  readonly VITE_GRAPH_SUBGRAPH_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
