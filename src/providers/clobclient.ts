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
let cachedOrderClient: ClobClient | null = null;
let cachedOrderConfig: { chainId: number; host: string; signatureType: number } | null = null;

type ClobErrorResponse = {
    error: unknown;
    status?: number;
};

type RawBalanceAllowanceResponse = BalanceAllowanceResponse & {
    allowance?: string;
    allowances?: Record<string, string>;
};

export type NormalizedBalanceAllowanceResponse = BalanceAllowanceResponse & {
    allowance: string;
    allowances?: Record<string, string>;
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

    // This project targets a Polymarket proxy/profile wallet funded via a separate signer.
    // Empirically, the matching CLOB balance/allowance endpoint for this account uses POLY_PROXY.
    return 1;
}

function resolveOrderSignatureType(): number {
    if (config.clobOrderSignatureType >= 0) {
        return config.clobOrderSignatureType;
    }
    return resolveSignatureType();
}

function normalizeAllowanceValue(value: RawBalanceAllowanceResponse): string {
    if (typeof value.allowance === "string") {
        return value.allowance;
    }

    if (value.allowances && Object.keys(value.allowances).length > 0) {
        const maxAllowance = Object.values(value.allowances).reduce<bigint>(
            (currentMax, entry) => {
                try {
                    const next = BigInt(entry);
                    return next > currentMax ? next : currentMax;
                } catch {
                    return currentMax;
                }
            },
            0n
        );
        return maxAllowance.toString();
    }

    return "0";
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
async function buildClient(signatureType: number): Promise<ClobClient> {
    const chainId = (config.chainId || Chain.POLYGON) as Chain;
    const host = config.clobApiUrl;

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

    const funderAddress = config.useProxyWallet ? config.proxyWalletAddress : undefined;
    return new ClobClient(host, chainId, wallet, apiKeyCreds, signatureType, funderAddress);
}

/**
 * Initialize ClobClient from credentials (cached singleton).
 * Supports both wallet-derived and server-provided credentials.
 */
export async function getClobClient(): Promise<ClobClient> {
    const chainId = (config.chainId || Chain.POLYGON) as Chain;
    const host = config.clobApiUrl;
    const signatureType = resolveSignatureType();

    if (
        cachedClient &&
        cachedConfig &&
        cachedConfig.chainId === chainId &&
        cachedConfig.host === host
    ) {
        return cachedClient;
    }

    cachedClient = await buildClient(signatureType);
    cachedConfig = { chainId, host };
    return cachedClient;
}

export async function getClobOrderClient(): Promise<ClobClient> {
    const chainId = (config.chainId || Chain.POLYGON) as Chain;
    const host = config.clobApiUrl;
    const signatureType = resolveOrderSignatureType();

    if (
        cachedOrderClient &&
        cachedOrderConfig &&
        cachedOrderConfig.chainId === chainId &&
        cachedOrderConfig.host === host &&
        cachedOrderConfig.signatureType === signatureType
    ) {
        return cachedOrderClient;
    }

    cachedOrderClient = await buildClient(signatureType);
    cachedOrderConfig = { chainId, host, signatureType };
    return cachedOrderClient;
}

/**
 * Clear cached ClobClient (useful for testing or re-initialization)
 */
export function clearClobClientCache(): void {
    cachedClient = null;
    cachedConfig = null;
    cachedOrderClient = null;
    cachedOrderConfig = null;
}

export async function getBalanceAllowanceStrict(
    client: ClobClient,
    params: BalanceAllowanceParams
): Promise<NormalizedBalanceAllowanceResponse> {
    const response = await client.getBalanceAllowance(params);
    const normalized = assertClobSuccess(
        response as RawBalanceAllowanceResponse | ClobErrorResponse,
        "CLOB getBalanceAllowance"
    );
    return {
        ...normalized,
        allowance: normalizeAllowanceValue(normalized),
    };
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
