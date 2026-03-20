import { validatePrivateKey } from "./security/validatePrivateKey";
import { createCredential } from "./security/createCredential";
import { approveUSDCAllowance, updateClobBalanceAllowance } from "./security/allowance";
import { getClobClient } from "./providers/clobclient";
import { waitForMinimumUsdcBalance } from "./utils/balance";
import { config } from "./config";
import { logger } from "pretty-ts-logger";

import { CopytradeArbBot } from "./order-builder/copytrade";
import { setupConsoleFileLogging } from "./utils/console-file";
import { AssetType } from "@polymarket/clob-client";

// Capture ALL logger info (stdout/stderr) into a local file.
// Configure via env var:
// - LOG_FILE_PATH="logs/bot-{date}.log" (daily) or "logs/bot.log" (single file)
// - LOG_DIR="logs" and LOG_FILE_PREFIX="bot" (daily; used if LOG_FILE_PATH not set)
setupConsoleFileLogging({
    logFilePath: config.logging.logFilePath,
    logDir: config.logging.logDir,
    filePrefix: config.logging.logFilePrefix,
});

function msUntilNext15mBoundary(now: Date = new Date()): number {
    const d = new Date(now);
    d.setSeconds(0, 0);
    const m = d.getMinutes();
    const nextMin = (Math.floor(m / 15) + 1) * 15;
    d.setMinutes(nextMin, 0, 0);
    return Math.max(0, d.getTime() - now.getTime());
}

async function waitForNextMarketStart(): Promise<void> {
    const ms = msUntilNext15mBoundary();
    if (ms <= 0) return;
    logger.info(
        `Waiting for next 15m market start: ${Math.ceil(ms / 1000)}s (start at next boundary)`
    );
    await new Promise((resolve) => setTimeout(resolve, ms));
    logger.info("Next 15m market started — starting bot now");
}

async function main() {
    logger.info("Starting the bot...");

    validatePrivateKey();

    // Create credentials if they don't exist
    const credential = await createCredential();
    if (credential) {
        logger.info("Credentials ready");
    }

    const clobClient = await getClobClient();

    if (!clobClient) {
        logger.info("Failed to initialize CLOB client - cannot continue");
        return;
    }

    // Approve USDC allowances to Polymarket contracts
    try {
        logger.info("Approving USDC allowances to Polymarket contracts...");
        await approveUSDCAllowance();

        // Update CLOB API to sync with on-chain allowances
        logger.info("Syncing allowances with CLOB API...");
        await updateClobBalanceAllowance(clobClient);
    } catch (error) {
        logger.info("Failed to approve USDC allowances", error);
        logger.info("Continuing without allowances - orders may fail");
    }

    // Extra proxy-mode guard:
    // In proxy mode, the actual funder is the proxy wallet, not necessarily the signer.
    if (config.useProxyWallet) {
        logger.info(
            `Proxy wallet mode enabled. Checking CLOB balance/allowance for funder ${config.proxyWalletAddress}...`
        );

        const balanceAllowance = await clobClient.getBalanceAllowance({
            asset_type: AssetType.COLLATERAL,
        });

        const proxyBalance = Number(balanceAllowance?.balance ?? 0);
        const proxyAllowance = Number(balanceAllowance?.allowance ?? 0);

        logger.info(
            `Proxy wallet CLOB state -> balance=${proxyBalance}, allowance=${proxyAllowance}`
        );

        if (proxyBalance <= 0) {
            throw new Error(
                `Proxy wallet ${config.proxyWalletAddress} has zero USDC balance on CLOB.`
            );
        }

        if (proxyAllowance <= 0) {
            throw new Error(
                `Proxy wallet ${config.proxyWalletAddress} has zero CLOB allowance. ` +
                `Do one manual approval/trade first from the Polymarket UI with this account.`
            );
        }
    }

    // Validation gate: proceed only once available USDC balance is >= configured minimum
    const { ok, available, allowance, balance } = await waitForMinimumUsdcBalance(
        clobClient,
        config.bot.minUsdcBalance,
        {
            pollIntervalMs: 15_000,
            timeoutMs: 0, // wait indefinitely
            logEveryPoll: true,
        }
    );

    logger.info(
        `waitForMinimumUsdcBalance ==> ok=${ok} available=${available} allowance=${allowance} balance=${balance}`
    );

    logger.info("Wallet is funded");

    if (available < 100) {
        logger.info(
            "Wallet balance is less than $100 USDC. Consider adding funds to avoid running out during trading."
        );
    }

    if (config.bot.waitForNextMarketStart) {
        await waitForNextMarketStart();
    } else {
        logger.info("Skipping wait for next 15m market start (resume immediately from state)");
    }

    const copytrade = await CopytradeArbBot.fromEnv(clobClient);

    // Handle graceful shutdown - generate summaries before exit
    const shutdown = async (signal: string) => {
        logger.info(`\n🛑 Received ${signal}, generating final summaries...`);
        copytrade.stop();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        process.exit(0);
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));

    await copytrade.start();
}

main().catch((error) => {
    logger.info("Fatal error", error);
    process.exit(1);
});
