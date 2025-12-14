
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

const ER_ENDPOINT = "https://devnet-as.magicblock.app";
const DEVNET_ENDPOINT = "https://api.devnet.solana.com";

async function main() {
    console.log("---------------------------------------");
    console.log("🧪 Balance Mirroring Test");
    console.log("---------------------------------------");

    const devConnection = new Connection(DEVNET_ENDPOINT, "confirmed");
    const erConnection = new Connection(ER_ENDPOINT, "confirmed");

    const wallet = Keypair.generate();
    console.log("Wallet:", wallet.publicKey.toString());

    // 1. Airdrop on Devnet
    console.log("1. Airdropping on Devnet...");
    try {
        const sig = await devConnection.requestAirdrop(wallet.publicKey, 1 * LAMPORTS_PER_SOL);
        await devConnection.confirmTransaction(sig, "confirmed");
        const balance = await devConnection.getBalance(wallet.publicKey);
        console.log("   -> Devnet Balance:", balance / LAMPORTS_PER_SOL, "SOL");
    } catch (e) {
        console.log("   -> Airdrop failed (Devnet limits?):", e.message);
        return;
    }

    // 2. Check ER Balance immediately
    console.log("2. Checking ER Balance...");
    try {
        const balance = await erConnection.getBalance(wallet.publicKey);
        console.log("   -> ER Balance:", balance / LAMPORTS_PER_SOL, "SOL");

        if (balance > 0) {
            console.log("   ✅ SUCCESS: Balances are mirrored!");
        } else {
            console.log("   ❌ FAILURE: Balances are NOT mirrored instantly.");

            // Wait a few seconds?
            console.log("   Waiting 5 seconds...");
            await new Promise(r => setTimeout(r, 5000));
            const balance2 = await erConnection.getBalance(wallet.publicKey);
            console.log("   -> ER Balance (after wait):", balance2 / LAMPORTS_PER_SOL, "SOL");
        }

    } catch (e) {
        console.error("   -> ER Check Failed:", e);
    }
}

main();
