
import { Connection, PublicKey, Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import { BN } from "bn.js";

// Load IDL
const IDL = JSON.parse(readFileSync("./app/src/idl/flappy_bird.json", "utf-8"));

// Config
// const ER_ENDPOINT = "https://devnet.magicblock.app";
// Use the endpoint from user logs
const ER_ENDPOINT = "https://devnet-as.magicblock.app";
const PROGRAM_ID = new PublicKey("DfJtsSqWNSetyRr3Fj4ZxM44oSBuZzAh4MTFMHQJSWvj");
const GAME_SEED = Buffer.from("game_v2");

// Generate a random wallet to ensure clean state
const TEST_WALLET = Keypair.generate();

// Derive PDA
const [gamePDA] = PublicKey.findProgramAddressSync(
    [GAME_SEED, TEST_WALLET.publicKey.toBuffer()],
    PROGRAM_ID
);

console.log("---------------------------------------------------------");
console.log("🧪 REPRO SCRIPT: Start Game Logic");
console.log("---------------------------------------------------------");
console.log("Wallet:", TEST_WALLET.publicKey.toString());
console.log("Game PDA:", gamePDA.toString());
console.log("Endpoint:", ER_ENDPOINT);

async function main() {
    const connection = new Connection(ER_ENDPOINT, { commitment: "confirmed" });
    const wallet = new Wallet(TEST_WALLET);
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    const program = new Program(IDL, provider);

    try {
        console.log("\n1. [ACTION] Initialize Game...");
        // Attempts to initialize directly on ER (Ephemeral-only account)
        // Note: For this to work, the ER validator must accept the tx and create the account.
        // It doesn't need Base Layer delegation if it's purely ephemeral.

        try {
            const tx = await program.methods
                .initialize()
                .accounts({
                    game: gamePDA,
                    authority: TEST_WALLET.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc({ skipPreflight: true }); // Skip preflight to avoid simulation errors masking logic

            console.log("   -> Tx Sent:", tx);
            await connection.confirmTransaction(tx, "confirmed");
            console.log("   -> Confirmed.");
        } catch (e) {
            console.error("   -> Init Failed:", e);
        }

        // Verify state
        console.log("\n2. [VERIFY] Fetching Game Account...");
        try {
            const account = await program.account.gameState.fetch(gamePDA);
            console.log("   -> Account Found!");
            console.log("   -> Status:", JSON.stringify(account.gameStatus));
        } catch (e) {
            console.error("   -> Fetch Failed:", e.message);
            console.log("   ⚠️ Stopping: Cannot proceed without account.");
            return;
        }

        // Now try start_game
        console.log("\n3. [ACTION] Start Game (Direct Authority)...");
        try {
            // We are calling as Authority, so session_token is null.
            // This tests if start_game works WITHOUT session keys first.
            const tx = await program.methods
                .startGame()
                .accounts({
                    game: gamePDA,
                    signer: TEST_WALLET.publicKey,
                    sessionToken: null,
                })
                .rpc({ skipPreflight: false }); // Enable preflight to see simulation logs

            console.log("   -> Tx Sent:", tx);
            await connection.confirmTransaction(tx, "confirmed");
            console.log("   -> Confirmed.");
        } catch (e) {
            console.error("   -> Start Game Failed:", e);
            if (e.logs) console.log("   -> Logs:", e.logs);
        }

        // Check state again
        console.log("\n4. [VERIFY] Fetching Game Account...");
        const account = await program.account.gameState.fetch(gamePDA);
        console.log("   -> Status:", JSON.stringify(account.gameStatus));

    } catch (err) {
        console.error("❌ Script Error:", err);
    }
}

main();
