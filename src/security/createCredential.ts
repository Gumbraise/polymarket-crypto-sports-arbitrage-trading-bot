import { ApiKeyCreds, ClobClient, Chain } from "@polymarket/clob-client";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { Wallet } from "@ethersproject/wallet";
import { logger } from "../utils/logger";
import { config } from "../config";

const CREDENTIAL_PATH = resolve(process.cwd(), "src/data/credential.json");

export function credentialPath(): string {
    return CREDENTIAL_PATH;
}

export function hasCredentialFile(): boolean {
    return existsSync(CREDENTIAL_PATH);
}

/**
 * Return true when the bot is configured to use pre-generated CLOB server credentials
 * instead of wallet-derived ones.
 */
export function isServerSignatureMode(): boolean {
    return config.signatureMethod === "server";
}

/**
 * Read CLOB API credentials from env vars (SIGNATURE_METHOD=server).
 * Throws if any of the three required vars is missing.
 */
export function getServerCredentials(): ApiKeyCreds {
    const key = config.clobApiKey;
    const secret = config.clobSecret;
    const passphrase = config.clobPassphrase;

    if (!key || !secret || !passphrase) {
        throw new Error(
            "SIGNATURE_METHOD=server requires CLOB_API_KEY, CLOB_SECRET, and CLOB_PASSPHRASE to be set in .env"
        );
    }

    return { key, secret, passphrase };
}

/**
 * Create API key credentials via createOrDeriveApiKey and save to src/data/credential.json.
 * Ensures src/data directory exists before writing.
 * Only used when SIGNATURE_METHOD=wallet (default).
 */
export async function createCredential(): Promise<ApiKeyCreds | null> {
    if (isServerSignatureMode()) {
        logger.info("SIGNATURE_METHOD=server — skipping wallet-based credential creation");
        return getServerCredentials();
    }

    const privateKey = config.privateKey;
    if (!privateKey) return (logger.error("PRIVATE_KEY not found"), null);

    try {
        const wallet = new Wallet(privateKey);
        logger.info(`wallet address ${wallet.address}`);
        const chainId = (config.chainId || Chain.POLYGON) as Chain;
        const host = config.clobApiUrl;

        // Create temporary ClobClient (no API key) and derive/create API key
        const clobClient = new ClobClient(host, chainId, wallet);
        const credential = await clobClient.createOrDeriveApiKey();
        await saveCredential(credential);

        logger.info("Credential created successfully");
        return credential;
    } catch (error) {
        logger.error("createCredential error", error);
        logger.error(
            `Error creating credential: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
}

export async function saveCredential(credential: ApiKeyCreds): Promise<void> {
    const dir = dirname(CREDENTIAL_PATH);
    mkdirSync(dir, { recursive: true });
    writeFileSync(CREDENTIAL_PATH, JSON.stringify(credential, null, 2));
}

/**
 * Ensure credentials are available.
 * - Server mode: validates that env vars are present (no file needed).
 * - Wallet mode: creates credential file via wallet signature if missing.
 */
export async function ensureCredential(): Promise<boolean> {
    if (isServerSignatureMode()) {
        try {
            getServerCredentials();
            return true;
        } catch {
            return false;
        }
    }

    if (hasCredentialFile()) return true;
    const credential = await createCredential();
    return credential !== null;
}