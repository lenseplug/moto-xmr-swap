/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_SWAP_VAULT_ADDRESS: string;
    readonly VITE_MOTO_TOKEN_ADDRESS: string;
    readonly VITE_COORDINATOR_URL: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
