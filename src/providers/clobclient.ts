import { readFileSync, existsSync } from "fs";
import { Chain, ClobClient } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import type {
    BalanceAllowanceParams,
    BalanceAllowanceResponse,
    OpenOrderParams,
    OpenOrdersResponse,
} from "@polymarket/clob-client";
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

type ClobErrorResponse = {
    error: unknown;
    status?: number;
};

function isClobErrorResponse(value: unknown): value is ClobErrorResponse {
    return typeof value === "object" && value !== null && "error" in value;
}

function formatClobError(error: unknown): string {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    return JSON.stringify(error);
}

function assertClobSuccess<T>(value: T | ClobErrorResponse, action: string): T {
    if (isClobErrorResponse(value)) {
        const status = typeof value.status === "number" ? ` (HTTP ${value.status})` : "";
        const baseMessage = `${action} failed${status}: ${formatClobError(value.error)}`;
        if (value.status === 401) {
            throw new Error(
                `${baseMessage}. Verify that PRIVATE_KEY matches the account that owns ` +
                `CLOB_API_KEY/CLOB_SECRET/CLOB_PASSPHRASE, and that proxy mode uses the correct funder address.`
            );
        }
        throw new Error(baseMessage);
    }
    return value;
}

function resolveSignatureType(): number {
    if (config.clobSignatureType >= 0) {
        return config.clobSignatureType;
    }

    if (!config.useProxyWallet) {
        return 0;
    }

    // Official Polymarket docs distinguish:
    // 1 = POLY_PROXY for Magic/email login
    // 2 = GNOSIS_SAFE for browser-wallet based Polymarket accounts (most common)
    return 2;
}

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

    const signatureType = resolveSignatureType();
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

export async function getBalanceAllowanceStrict(
    client: ClobClient,
    params: BalanceAllowanceParams
): Promise<BalanceAllowanceResponse> {
    const response = await client.getBalanceAllowance(params);
    return assertClobSuccess(response, "CLOB getBalanceAllowance");
}

export async function updateBalanceAllowanceStrict(
    client: ClobClient,
    params: BalanceAllowanceParams
): Promise<void> {
    const response = await client.updateBalanceAllowance(params);
    assertClobSuccess(response as void | ClobErrorResponse, "CLOB updateBalanceAllowance");
}

export async function getOpenOrdersStrict(
    client: ClobClient,
    params?: OpenOrderParams
): Promise<OpenOrdersResponse> {
    const response = await client.getOpenOrders(params);
    return assertClobSuccess(response, "CLOB getOpenOrders");
}
