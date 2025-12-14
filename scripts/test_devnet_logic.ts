
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { FlappyBird } from "../target/types/flappy_bird";
import { readFileSync } from "fs";

// ========================================
// Configuration (DEVNET)
// ========================================
const BASE_LAYER_URL = "https://api.devnet.solana.com";
const ER_URL = "https://devnet-as.magicblock.app";
const ER_WS_URL = "wss://devnet-as.magicblock.app";

// Devnet ER validator identity (from use-flappy-bird-program.ts)
const ER_VALIDATOR = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");

// Game seed - must match program
const GAME_SEED = Buffer.from("game_v2");

const IDL = JSON.parse(readFileSync("./app/src/idl/flappy_bird.json", "utf-8"));

async function main() {
    console.log("---------------------------------------------------");
    console.log("🧪 FLAPPY BIRD SMART CONTRACT VERIFICATION (DEVNET)");
    console.log("---------------------------------------------------");

    // 1. Providers
    const keypairData = JSON.parse(readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8"));
    const walletKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
    const wallet = new anchor.Wallet(walletKeypair);

    console.log("Wallet:", wallet.publicKey.toString());

    const baseConnection = new Connection(BASE_LAYER_URL, "confirmed");
    const erConnection = new Connection(ER_URL, { wsEndpoint: ER_WS_URL, commitment: "confirmed" });

    const provider = new anchor.AnchorProvider(baseConnection, wallet, { commitment: "confirmed" });
    anchor.setProvider(provider);

    const erProvider = new anchor.AnchorProvider(erConnection, wallet, { commitment: "confirmed" });

    const program = new Program(IDL, provider);
    const erProgram = new Program(IDL, erProvider);

    // Assume program ID from IDL
    const PROGRAM_ID = new PublicKey(IDL.address);

    // Derive game PDA
    const [gamePDA] = PublicKey.findProgramAddressSync(
        [GAME_SEED, wallet.publicKey.toBuffer()],
        PROGRAM_ID
    );
    console.log("Game PDA:", gamePDA.toString());

    // Helper to send to ER
    const sendToER = async (tx: Transaction) => {
        tx.feePayer = wallet.publicKey;
        // Get fresh blockhash from ER
        const { blockhash, lastValidBlockHeight } = await erConnection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;

        const signed = await wallet.signTransaction(tx);
        const sig = await erConnection.sendRawTransaction(signed.serialize(), { skipPreflight: true });

        // Confirm
        const conf = await erConnection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        if (conf.value.err) {
            throw new Error(`Tx Failed: ${JSON.stringify(conf.value.err)}`);
        }
        return sig;
    };

    // ----------------------------------------------------
    // CHECK 1: INITIALIZE (BASE)
    // ----------------------------------------------------
    process.stdout.write("1. Initialize (Base Layer)... ");
    const info = await baseConnection.getAccountInfo(gamePDA);
    if (info) {
        console.log("Exists.");
    } else {
        try {
            const tx = await program.methods
                .initialize()
                .accounts({
                    authority: wallet.publicKey,
                } as any)
                .rpc();
            await baseConnection.confirmTransaction(tx, "confirmed");
            console.log("✅ Initialized:", tx);
        } catch (e) {
            console.error("❌ Failed:", e.message);
            return;
        }
    }

    // ----------------------------------------------------
    // CHECK 2: DELEGATE
    // ----------------------------------------------------
    process.stdout.write("2. Delegate (Base Layer)... ");
    const info2 = await baseConnection.getAccountInfo(gamePDA);
    const DELEGATION_PROG = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

    if (info2 && info2.owner.equals(DELEGATION_PROG)) {
        console.log("Already delegated.");
    } else {
        try {
            const tx = await program.methods
                .delegate()
                .accounts({
                    payer: wallet.publicKey,
                } as any)
                .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }])
                .rpc();
            await baseConnection.confirmTransaction(tx, "confirmed");
            console.log("✅ Delegated:", tx);

            console.log("   ⏳ Waiting 5s for sync...");
            await new Promise(r => setTimeout(r, 5000));
        } catch (e) {
            console.error("❌ Failed:", e.message);
            return;
        }
    }

    // ----------------------------------------------------
    // CHECK 3: START GAME (ER) - MAIN WALLET
    // ----------------------------------------------------
    process.stdout.write("3. Start Game (ER)... ");
    try {
        // Wait for ER sync if needed
        let synced = false;
        for (let i = 0; i < 10; i++) {
            const acc = await erConnection.getAccountInfo(gamePDA);
            if (acc) { synced = true; break; }
            await new Promise(r => setTimeout(r, 1000));
        }
        if (!synced) {
            console.log("❌ ER Sync Missing");
            return;
        }

        const tx = await erProgram.methods
            .startGame()
            .accounts({
                game: gamePDA,
                signer: wallet.publicKey,
                sessionToken: null
            } as any)
            .transaction();

        const sig = await sendToER(tx);
        console.log("✅ Success! Tx:", sig);

        const state = await erProgram.account.gameState.fetch(gamePDA);
        console.log("   -> GameStatus:", Object.keys(state.gameStatus)[0]);
        if (Object.keys(state.gameStatus)[0] !== "playing") {
            console.log("   ❌ Error: Status is not 'playing'");
        }
    } catch (e: any) {
        if (e.message.includes("GameAlreadyStarted")) {
            console.log("⚠️ Already Started (OK)");
        } else {
            console.error("\n❌ Start Failed:", e);
            return;
        }
    }

    // ----------------------------------------------------
    // CHECK 4: FLAP (ER) - MAIN WALLET
    // ----------------------------------------------------
    process.stdout.write("4. Flap (ER)... ");
    try {
        const tx = await erProgram.methods
            .flap()
            .accounts({
                game: gamePDA,
                signer: wallet.publicKey,
                sessionToken: null
            } as any)
            .transaction();
        const sig = await sendToER(tx);
        console.log("✅ Success! Tx:", sig);

        const state = await erProgram.account.gameState.fetch(gamePDA);
        console.log("   -> Velocity:", state.birdVelocity);
        if (state.birdVelocity >= 0) {
            console.log("   ⚠️ Warning: Velocity not negative (upward) as expected immediately after flap?");
            // Actually gravity applies after flap in same tick, so -8000 + 100 = -7900. Should be negative.
        }
    } catch (e) {
        console.error("\n❌ Flap Failed:", e);
    }

    // ----------------------------------------------------
    // CHECK 5: TICK (ER) - MAIN WALLET
    // ----------------------------------------------------
    process.stdout.write("5. Tick (ER)... ");
    try {
        const tx = await erProgram.methods
            .tick()
            .accounts({
                game: gamePDA,
                signer: wallet.publicKey,
                sessionToken: null
            } as any)
            .transaction();
        const sig = await sendToER(tx);
        console.log("✅ Success! Tx:", sig);

        const state = await erProgram.account.gameState.fetch(gamePDA);
        console.log("   -> Frame Count:", state.frameCount.toString());
        if (state.frameCount.toNumber() === 0) {
            console.log("   ❌ Error: Frame count did not increase");
        }
    } catch (e) {
        console.error("\n❌ Tick Failed:", e);
    }

    console.log("---------------------------------------------------");
    console.log("✅ CONTRACT VERIFICATION COMPLETE");
    console.log("---------------------------------------------------");
}

main();
