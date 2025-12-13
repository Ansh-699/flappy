/**
 * Debug script to check if on-chain game state is updating correctly
 * 
 * Run with: bun run scripts/debug-game-state.ts
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import { Keypair } from "@solana/web3.js";

// Load IDL
const IDL = JSON.parse(readFileSync("./app/src/idl/flappy_bird.json", "utf-8"));

// Configuration - using devnet ER
const ER_ENDPOINT = "https://devnet.magicblock.app";
const ER_WS_ENDPOINT = "wss://devnet.magicblock.app";
const PROGRAM_ID = new PublicKey("DfJtsSqWNSetyRr3Fj4ZxM44oSBuZzAh4MTFMHQJSWvj");
const GAME_SEED = Buffer.from("game_v2");

// Player wallet - the one you're testing with
const PLAYER_WALLET = new PublicKey("anshxnbjGiUpsZpnx3c6LrK2vt8zt54vLMvY3C7Locm");

// Derive PDA
const [gamePDA] = PublicKey.findProgramAddressSync(
    [GAME_SEED, PLAYER_WALLET.toBuffer()],
    PROGRAM_ID
);

console.log("═══════════════════════════════════════════════════════════════");
console.log("🐦 Flappy Bird Game State Debug Script");
console.log("═══════════════════════════════════════════════════════════════");
console.log("Program ID:", PROGRAM_ID.toString());
console.log("Player:", PLAYER_WALLET.toString());
console.log("Game PDA:", gamePDA.toString());
console.log("ER Endpoint:", ER_ENDPOINT);
console.log("═══════════════════════════════════════════════════════════════\n");

async function main() {
    // Create connection to ER
    const erConnection = new Connection(ER_ENDPOINT, {
        wsEndpoint: ER_WS_ENDPOINT,
        commitment: "confirmed",
    });

    // Create a dummy wallet for read-only operations
    const dummyKeypair = Keypair.generate();
    const dummyWallet = new Wallet(dummyKeypair);
    const provider = new AnchorProvider(erConnection, dummyWallet, { commitment: "confirmed" });
    const program = new Program(IDL, provider);

    try {
        // Fetch game state from ER
        console.log("📡 Fetching game state from Ephemeral Rollup...\n");

        const gameAccount = await program.account.gameState.fetch(gamePDA);

        console.log("✅ Game state fetched successfully!\n");
        console.log("───────────────────────────────────────────────────────────────");
        console.log("GAME STATE:");
        console.log("───────────────────────────────────────────────────────────────");
        console.log("  Authority:", gameAccount.authority.toString());
        console.log("  Score:", gameAccount.score.toString());
        console.log("  High Score:", gameAccount.highScore.toString());
        console.log("  Game Status:", JSON.stringify(gameAccount.gameStatus));
        console.log("  Bird Y (raw):", gameAccount.birdY);
        console.log("  Bird Y (pixels):", gameAccount.birdY / 1000);
        console.log("  Bird Velocity (raw):", gameAccount.birdVelocity);
        console.log("  Bird Velocity (per tick):", gameAccount.birdVelocity / 1000);
        console.log("  Frame Count:", gameAccount.frameCount.toString());
        console.log("  Last Update:", new Date(Number(gameAccount.lastUpdate) * 1000).toISOString());
        console.log("  Next Pipe Spawn X:", gameAccount.nextPipeSpawnX);
        console.log("  Seed:", gameAccount.seed.toString());

        console.log("\n───────────────────────────────────────────────────────────────");
        console.log("PIPES:");
        console.log("───────────────────────────────────────────────────────────────");

        const pipes = gameAccount.pipes || [];
        let activePipes = 0;

        for (let i = 0; i < pipes.length; i++) {
            const pipe = pipes[i];
            console.log(`  Pipe ${i}:`);
            console.log(`    X: ${pipe.x} (pixels)`);
            console.log(`    Gap Y: ${pipe.gapY} (pixels)`);
            console.log(`    Passed: ${pipe.passed}`);
            console.log(`    Active: ${pipe.active}`);
            if (pipe.active) activePipes++;
        }

        console.log(`\n  Total Active Pipes: ${activePipes}`);

        console.log("\n───────────────────────────────────────────────────────────────");
        console.log("ANALYSIS:");
        console.log("───────────────────────────────────────────────────────────────");

        // Check game status
        const status = gameAccount.gameStatus;
        if (status.notStarted) {
            console.log("  ⚠️  Game status is NOT STARTED - need to call startGame first!");
        } else if (status.playing) {
            console.log("  ✅ Game status is PLAYING");
        } else if (status.gameOver) {
            console.log("  ❌ Game status is GAME OVER");
        }

        // Check if bird is moving
        if (gameAccount.frameCount.toNumber() === 0) {
            console.log("  ⚠️  Frame count is 0 - tick() is not being called!");
        } else {
            console.log(`  ✅ Frame count is ${gameAccount.frameCount} - tick() is working`);
        }

        // Check pipes
        if (activePipes === 0) {
            console.log("  ⚠️  No active pipes - spawn_pipes() might not be running");
        } else {
            console.log(`  ✅ ${activePipes} active pipes found`);
        }

        // Check bird physics
        const birdYPixels = gameAccount.birdY / 1000;
        if (birdYPixels < 0 || birdYPixels > 400) {
            console.log(`  ⚠️  Bird Y (${birdYPixels}) is out of bounds [0-400]`);
        } else {
            console.log(`  ✅ Bird Y (${birdYPixels}) is within bounds`);
        }

        console.log("\n═══════════════════════════════════════════════════════════════");

        // Now monitor for changes
        console.log("\n🔄 Monitoring game state for 10 seconds...\n");

        let pollCount = 0;
        const startFrameCount = gameAccount.frameCount.toNumber();
        const startBirdY = gameAccount.birdY;

        const interval = setInterval(async () => {
            try {
                const updatedGame = await program.account.gameState.fetch(gamePDA);
                pollCount++;

                const frameChange = updatedGame.frameCount.toNumber() - startFrameCount;
                const birdYChange = updatedGame.birdY - startBirdY;

                console.log(`  Poll ${pollCount}: Frame +${frameChange}, Bird Y: ${updatedGame.birdY / 1000} (Δ${birdYChange / 1000})`);
            } catch (err) {
                console.log(`  Poll ${pollCount}: Error - ${err}`);
            }
        }, 1000);

        await new Promise(resolve => setTimeout(resolve, 10000));
        clearInterval(interval);

        // Final stats
        const finalGame = await program.account.gameState.fetch(gamePDA);
        const totalFrameChange = finalGame.frameCount.toNumber() - startFrameCount;

        console.log("\n───────────────────────────────────────────────────────────────");
        console.log("FINAL ANALYSIS:");
        console.log("───────────────────────────────────────────────────────────────");

        if (totalFrameChange > 0) {
            console.log(`  ✅ Game updated ${totalFrameChange} frames in 10 seconds`);
            console.log("     → Backend is working, issue is likely FRONTEND rendering");
        } else {
            console.log("  ❌ Game did NOT update - no frames processed");
            console.log("     → Backend issue: tick() is not being called or failing");
        }

        console.log("\n═══════════════════════════════════════════════════════════════\n");

    } catch (err) {
        console.error("❌ Failed to fetch game state:", err);
        console.log("\nPossible issues:");
        console.log("  1. Game not initialized on ER");
        console.log("  2. Wrong player wallet address");
        console.log("  3. ER endpoint not reachable");
    }
}

main().catch(console.error);
