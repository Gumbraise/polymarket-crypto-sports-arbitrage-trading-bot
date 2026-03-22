import { readFileSync, existsSync } from "fs";
import { Chain, ClobClient } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { config } from "../config";
import {
    ensureCredential,
    credentialPath,
    isServerSignatureMode,
    getServerCredentials,
} from "../security/createCredential";

// Cache for ClobClient instance to avoid repeated initialization
let cachedClient: ClobClient | null = null;
let cachedConfig: { chainId: number; host: string } | null = null;

/**
 * Resolve API key credentials depending on SIGNATURE_METHOD.
 * - "server": reads CLOB_API_KEY / CLOB_SECRET / CLOB_PASSPHRASE from env
 * - "wallet" (default): reads from credential.json file (created via wallet signature)
 */
async function resolveCredentials(): Promise<ApiKeyCreds> {
    if (isServerSignatureMode()) {
        return getServerCredentials();
    }

    // Wallet mode — ensure the credential file exists
    if (!existsSync(credentialPath())) {
        const ok = await ensureCredential();
        if (!ok) {
            throw new Error(
                "Credential file not found and could not create one. Set PRIVATE_KEY and ensure the wallet can create a Polymarket API key."
            );
        }
    }
    return JSON.parse(readFileSync(credentialPath(), "utf-8"));
}

/**
 * Initialize ClobClient from credentials (cached singleton).
 * Supports both wallet-derived and server-provided credentials.
 */
export async function getClobClient(): Promise<ClobClient> {
    const chainId = (config.chainId || Chain.POLYGON) as Chain;
    const host = config.clobApiUrl;

    // Return cached client if config hasn't changed
    if (cachedClient && cachedConfig &&
        cachedConfig.chainId === chainId &&
        cachedConfig.host === host) {
        return cachedClient;
    }

    const creds = await resolveCredentials();

    // Create wallet from private key
    const privateKey = config.requirePrivateKey();
    const wallet = new Wallet(privateKey);

    // Convert base64url secret to standard base64 for clob-client compatibility
    const secretBase64 = creds.secret.replace(/-/g, '+').replace(/_/g, '/');

    const apiKeyCreds: ApiKeyCreds = {
        key: creds.key,
        secret: secretBase64,
        passphrase: creds.passphrase,
    };

    // Signature type: 0 = EOA (browser/MetaMask), 2 = proxy/smart wallet.
    const signatureType = config.useProxyWallet ? 2 : 0;
    const funderAddress = config.useProxyWallet ? config.proxyWalletAddress : undefined;

    // Create and cache client
    cachedClient = new ClobClient(host, chainId, wallet, apiKeyCreds, signatureType, funderAddress);
    cachedConfig = { chainId, host };

    return cachedClient;
}

/**
 * Clear cached ClobClient (useful for testing or re-initialization)
 */
export function clearClobClientCache(): void {
    cachedClient = null;
    cachedConfig = null;
}