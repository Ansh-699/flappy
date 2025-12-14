
import { Connection, PublicKey, Keypair, Transaction, SystemProgram } from "@solana/web3.js";

const ER_ENDPOINT = "https://devnet-as.magicblock.app";

async function main() {
    const connection = new Connection(ER_ENDPOINT, "confirmed");
    const wallet = Keypair.generate();
    console.log("Wallet:", wallet.publicKey.toString());

    // 1. Try sending a tx with 0 lamports
    console.log("\n1. sending 0-lamport tx...");
    const tx = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: wallet.publicKey,
            lamports: 0
        })
    );
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(wallet); // This signs as Fee Payer (Writable)

    try {
        await connection.sendRawTransaction(tx.serialize());
        console.log("   -> Success (Unexpected if 0 fee is not enabled)");
    } catch (e) {
        console.log("   -> Failed as expected:", e.message);
        if (JSON.stringify(e).includes("InvalidWritableAccount")) {
            console.log("   ✅ MATCHES HYPOTHESIS: InvalidWritableAccount with 0 lamports!");
        }
    }

    // 2. Fund the wallet
    console.log("\n2. Funding wallet...");
    try {
        const sig = await connection.requestAirdrop(wallet.publicKey, 1000000000); // 1 SOL
        await connection.confirmTransaction(sig, "confirmed");
        console.log("   -> Funded.");

        // Check balance
        const balance = await connection.getBalance(wallet.publicKey);
        console.log("   -> Balance:", balance);

        // 3. Retry tx
        console.log("\n3. Retrying tx...");
        const tx2 = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: wallet.publicKey,
                lamports: 0 // Self transfer
            })
        );
        tx2.feePayer = wallet.publicKey;
        // Need new blockhash?
        tx2.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx2.sign(wallet);

        const sig2 = await connection.sendRawTransaction(tx2.serialize());
        await connection.confirmTransaction(sig2, "confirmed");
        console.log("   -> Success! Tx Hash:", sig2);

    } catch (e) {
        console.error("   -> Funding/Retry Failed:", e);
    }
}

main();
