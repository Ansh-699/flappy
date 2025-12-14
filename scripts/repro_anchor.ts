
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "fs";

// Config
const DEVNET_ENDPOINT = "https://api.devnet.solana.com";
const ER_ENDPOINT = "https://devnet-as.magicblock.app";
const ER_VALIDATOR = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"); // From use-flappy-bird-program.ts

const IDL = JSON.parse(readFileSync("./app/src/idl/flappy_bird.json", "utf-8"));
const GAME_SEED = Buffer.from("game_v2");

// Wallet
const keypairData = JSON.parse(readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8"));
const walletKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
const wallet = new Wallet(walletKeypair);

console.log("-----------------------------------------");
console.log("🧪 ANCHOR REPRO: Init -> Delegate -> Start");
console.log("-----------------------------------------");
console.log("Wallet:", wallet.publicKey.toString());

async function main() {
    // 1. Providers
    const devConnection = new Connection(DEVNET_ENDPOINT, "confirmed");
    const erConnection = new Connection(ER_ENDPOINT, "confirmed");

    const devProvider = new AnchorProvider(devConnection, wallet, { commitment: "confirmed" });
    const erProvider = new AnchorProvider(erConnection, wallet, { commitment: "confirmed" });

    const devProgram = new Program(IDL, devProvider);
    const erProgram = new Program(IDL, erProvider);

    const [gamePDA] = PublicKey.findProgramAddressSync(
        [GAME_SEED, wallet.publicKey.toBuffer()],
        devProgram.programId
    );
    console.log("Game PDA:", gamePDA.toString());

    try {
        // 2. Initialize on Devnet (if needed)
        console.log("\n1. [DEVNET] Initialize...");
        try {
            const tx = await devProgram.methods
                .initialize()
                .accounts({
                    authority: wallet.publicKey,
                    // game: derived automatically by Anchor? Need to check IDL.
                    // IDL says seeds = [GAME_SEED, authority]. Anchor resolves this.
                })
                .rpc();
            console.log("   -> Init Tx:", tx);
            await devConnection.confirmTransaction(tx, "confirmed");
        } catch (e) {
            if (e.message.includes("already in use")) {
                console.log("   -> Account already exists (OK).");
            } else {
                console.error("   -> Init Error:", e);
                // Proceed anyway?
            }
        }

        // 3. Delegate to ER (on Devnet)
        console.log("\n2. [DEVNET] Delegate...");
        // Check if already delegated?
        const accInfo = await devConnection.getAccountInfo(gamePDA);
        const DELEGATION_PROG = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

        if (accInfo && accInfo.owner.equals(DELEGATION_PROG)) {
            console.log("   -> Already Delegated.");
        } else {
            const tx = await devProgram.methods
                .delegate()
                .accounts({
                    payer: wallet.publicKey,
                })
                .remainingAccounts([
                    { pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }
                ])
                .rpc();
            console.log("   -> Delegate Tx:", tx);
            await devConnection.confirmTransaction(tx, "confirmed");

            console.log("   -> Waiting for sync (5s)...");
            await new Promise(r => setTimeout(r, 5000));
        }

        // 4. Start Game on ER
        console.log("\n3. [ER] Start Game...");
        try {
            // Check if account exists on ER
            const erAcc = await erConnection.getAccountInfo(gamePDA);
            if (!erAcc) {
                console.log("   ❌ Account NOT synced to ER yet.");
                return;
            }
            console.log("   ✅ Account synced to ER. Owner:", erAcc.owner.toString());

            // Call Start Game
            // Note: We use the ER Provider
            const tx = await erProgram.methods
                .startGame()
                .accounts({
                    game: gamePDA,
                    signer: wallet.publicKey,
                    sessionToken: null, // No session token
                })
                .rpc({ skipPreflight: true }); // skipPreflight to land it

            console.log("   -> Start Tx:", tx);

            const conf = await erConnection.confirmTransaction(tx, "confirmed");
            if (conf.value.err) {
                console.error("   ❌ Start Transaction Failed:", JSON.stringify(conf.value.err));
            } else {
                console.log("   ✅ Start Success!");
            }

        } catch (e) {
            console.error("   -> Start Error:", e);
            if (e.logs) console.log(e.logs);
        }

    } catch (err) {
        console.error("Global Error:", err);
    }
}

main();
