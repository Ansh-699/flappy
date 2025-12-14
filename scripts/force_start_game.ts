
import { Connection, PublicKey, Keypair, Transaction } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

// Load IDL
const IDL = JSON.parse(readFileSync("./app/src/idl/flappy_bird.json", "utf-8"));

// Config
const ER_ENDPOINT = "https://devnet.magicblock.app"; // Using generic endpoint -- generic endpoint routes based on account usually
const ER_WS_ENDPOINT = "wss://devnet.magicblock.app";
const PROGRAM_ID = new PublicKey("DfJtsSqWNSetyRr3Fj4ZxM44oSBuZzAh4MTFMHQJSWvj");
const GAME_SEED = Buffer.from("game_v2");

// Player Wallet (test wallet)
const TEST_WALLET = Keypair.generate();

// Derive PDA
const [gamePDA] = PublicKey.findProgramAddressSync(
    [GAME_SEED, TEST_WALLET.publicKey.toBuffer()],
    PROGRAM_ID
);

console.log("═══════════════════════════════════════════════════════════════");
console.log("🚀 Flappy Bird Force Start Debug Script");
console.log("═══════════════════════════════════════════════════════════════");
console.log("Test Wallet:", TEST_WALLET.publicKey.toString());
console.log("Game PDA:", gamePDA.toString());
console.log("ER Endpoint:", ER_ENDPOINT);
console.log("═══════════════════════════════════════════════════════════════\n");

async function main() {
    const connection = new Connection(ER_ENDPOINT, {
        wsEndpoint: ER_WS_ENDPOINT,
        commitment: "confirmed",
    });

    const wallet = new Wallet(TEST_WALLET);
    // Use a provider that can sign
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    const program = new Program(IDL, provider);

    try {
        console.log("1. Initializing Game on ER (Purely Ephemeral)...");
        // Note: Without base layer delegation, this creates an account ONLY on this ER node
        try {
            const tx = await program.methods
                .initialize()
                .accounts({
                    authority: TEST_WALLET.publicKey,
                })
                .rpc({ skipPreflight: true });
            console.log("   ✅ Initialize Tx:", tx);

            // Wait for confirmation
            await connection.confirmTransaction(tx, "confirmed");
        } catch (e) {
            console.log("   ⚠️ Initialize Error (might be okay if already exists? no, it's new):", e);
        }

        console.log("2. Fetching State (Post-Init)...");
        try {
            let account = await program.account.gameState.fetch(gamePDA);
            console.log("   Status:", JSON.stringify(account.gameStatus));
        } catch (e) {
            console.log("   ❌ Fetch Failed (Account might not exist):", e.message);
            return;
        }

        console.log("3. Calling start_game...");
        try {
            const tx = await program.methods
                .startGame()
                .accounts({
                    game: gamePDA,
                    signer: TEST_WALLET.publicKey,
                    sessionToken: null,
                })
                .rpc({ skipPreflight: true });
            console.log("   ✅ Start Game Tx:", tx);
            await connection.confirmTransaction(tx, "confirmed");
        } catch (e) {
            console.error("   ❌ Start Game Failed:", e);
        }

        console.log("4. Fetching State (Post-Start)...");
        let account = await program.account.gameState.fetch(gamePDA);
        console.log("   Status:", JSON.stringify(account.gameStatus));

        if (JSON.stringify(account.gameStatus).includes("playing")) {
            console.log("   ✅ SUCCESS: State transitioned to Playing!");
        } else {
            console.log("   ❌ FAILURE: State remained NotStarted.");
        }

    } catch (err) {
        console.error("❌ Script Error:", err);
    }
}

main();
