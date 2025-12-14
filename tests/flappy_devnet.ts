
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { FlappyBird } from "../target/types/flappy_bird";
import { expect } from "chai";
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

// Game constants (must match program)
const GAME_HEIGHT = 400; // Scaled by 1000 in program, here we check raw values usually? 
// Actually program returns scaled values, so we check against scaled.
// In check: birdY / 1000

describe("Flappy Bird - DEVNET Verification", () => {
    // Opt-in: requires a funded devnet wallet and the program deployed on devnet.
    if (process.env.RUN_DEVNET_TESTS !== "1") {
        console.log("\n[skip] Devnet tests: set RUN_DEVNET_TESTS=1 to run flappy_devnet.ts\n");
        return;
    }
    // 1. Providers
    // We use a funded wallet from id.json if available, or generate one
    // But for this test to work on Devnet, we need funds.
    // The environment's ANCHOR_WALLET should be set.

    // We'll manually construct providers to ensure we control connections
    const keypairData = JSON.parse(readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8"));
    const walletKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
    const wallet = new anchor.Wallet(walletKeypair);

    const baseConnection = new Connection(BASE_LAYER_URL, "confirmed");
    const erConnection = new Connection(ER_URL, { wsEndpoint: ER_WS_URL, commitment: "confirmed" });

    const provider = new anchor.AnchorProvider(baseConnection, wallet, { commitment: "confirmed" });
    anchor.setProvider(provider);

    const erProvider = new anchor.AnchorProvider(erConnection, wallet, { commitment: "confirmed" });

    // We load program from IDL to allow running without full workspace build if needed
    // But we should use workspace if available. Let's try workspace first, fallback to manual.
    let program: Program<FlappyBird>;
    let erProgram: Program<FlappyBird>;

    // We assume the program ID in IDL is correct (DfJts...)
    const PROGRAM_ID = new PublicKey(IDL.address);

    program = new Program(IDL, provider);
    erProgram = new Program(IDL, erProvider);

    // Derive game PDA
    const [gamePDA] = PublicKey.findProgramAddressSync(
        [GAME_SEED, wallet.publicKey.toBuffer()],
        PROGRAM_ID
    );

    console.log("---------------------------------------------------");
    console.log("🧪 FLAPPY BIRD DEVNET TEST");
    console.log("Wallet:", wallet.publicKey.toString());
    console.log("Game PDA:", gamePDA.toString());
    console.log("---------------------------------------------------");

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

    it("1. Initialize (Base Layer)", async () => {
        // Check if exists
        const info = await baseConnection.getAccountInfo(gamePDA);
        if (info) {
            console.log("   ℹ️ Account exists.");
        } else {
            console.log("   ℹ️ Initializing...");
            const tx = await program.methods
                .initialize()
                .accounts({
                    authority: wallet.publicKey,
                } as any)
                .rpc();
            await baseConnection.confirmTransaction(tx, "confirmed");
            console.log("   ✅ Initialized:", tx);
        }
    });

    it("2. Delegate (Base Layer -> ER)", async () => {
        const info = await baseConnection.getAccountInfo(gamePDA);
        const DELEGATION_PROG = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

        if (info && info.owner.equals(DELEGATION_PROG)) {
            console.log("   ℹ️ Already delegated.");
        } else {
            console.log("   ℹ️ Delegating...");
            const tx = await program.methods
                .delegate()
                .accounts({
                    payer: wallet.publicKey,
                } as any)
                .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }])
                .rpc();
            await baseConnection.confirmTransaction(tx, "confirmed");
            console.log("   ✅ Delegated:", tx);

            console.log("   ⏳ Waiting for sync...");
            await new Promise(r => setTimeout(r, 5000));
        }
    });

    it("3. Start Game (ER) - Main Wallet", async () => {
        // Wait for ER sync if needed
        let synced = false;
        for (let i = 0; i < 10; i++) {
            const acc = await erConnection.getAccountInfo(gamePDA);
            if (acc) { synced = true; break; }
            await new Promise(r => setTimeout(r, 1000));
        }
        if (!synced) throw new Error("Account not synced to ER");

        console.log("   ℹ️ Starting Game...");
        const tx = await erProgram.methods
            .startGame()
            .accounts({
                game: gamePDA,
                signer: wallet.publicKey,
                sessionToken: null
            } as any)
            .transaction();

        const sig = await sendToER(tx);
        console.log("   ✅ Start Game Tx:", sig);

        const state = await erProgram.account.gameState.fetch(gamePDA);
        // GameStatus::Playing is enum variant 1 (NotStarted=0, Playing=1, GameOver=2)
        // Anchor enums form: { playing: {} }
        expect(state.gameStatus).to.have.property("playing");
    });

    it("4. Flap (ER) - Main Wallet", async () => {
        console.log("   ℹ️ Flapping...");
        const tx = await erProgram.methods
            .flap()
            .accounts({
                game: gamePDA,
                signer: wallet.publicKey,
                sessionToken: null
            } as any)
            .transaction();
        const sig = await sendToER(tx);
        console.log("   ✅ Flap Tx:", sig);

        const state = await erProgram.account.gameState.fetch(gamePDA);
        // Initial velocity 0 -> Flap sets to -9000 -> Gravity adds +600 -> -8400?
        // Check if roughly correct magnitude
        console.log("   Check velocity:", state.birdVelocity);
        expect(state.birdVelocity).to.be.lessThan(0);
    });

});
