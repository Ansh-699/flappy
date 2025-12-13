import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import { Keypair } from "@solana/web3.js";

const IDL = JSON.parse(readFileSync("./app/src/idl/flappy_bird.json", "utf-8"));
const ER_ENDPOINT = "https://devnet.magicblock.app";
const PROGRAM_ID = new PublicKey("DfJtsSqWNSetyRr3Fj4ZxM44oSBuZzAh4MTFMHQJSWvj");

// NEW game PDA from the other browser session
const gamePDA = new PublicKey("C2YPRQeL5aCcVANTGt9VSZ9cwTApzMTRZfv9aFqVZCwX");

console.log("Checking game state for PDA:", gamePDA.toString());

async function main() {
    const erConnection = new Connection(ER_ENDPOINT, { commitment: "confirmed" });
    const dummyKeypair = Keypair.generate();
    const dummyWallet = new Wallet(dummyKeypair);
    const provider = new AnchorProvider(erConnection, dummyWallet, { commitment: "confirmed" });
    const program = new Program(IDL as any, provider);

    try {
        const gameAccount = await (program.account as any).gameState.fetch(gamePDA);

        console.log("\n=== GAME STATE ===");
        console.log("Score:", gameAccount.score.toString());
        console.log("Game Status:", JSON.stringify(gameAccount.gameStatus));
        console.log("Bird Y (pixels):", gameAccount.birdY / 1000);
        console.log("Bird Velocity:", gameAccount.birdVelocity);
        console.log("Frame Count:", gameAccount.frameCount.toString());

        console.log("\n=== PIPES ===");
        let activePipes = 0;
        for (let i = 0; i < gameAccount.pipes.length; i++) {
            const p = gameAccount.pipes[i];
            if (p.active) {
                activePipes++;
                console.log(`  Pipe ${i}: x=${p.x}, gapY=${p.gapY}, passed=${p.passed}`);
            }
        }
        console.log("Active Pipes:", activePipes);

        if (activePipes > 0) {
            console.log("\n✅ BACKEND IS WORKING! Pipes are spawning.");
        } else if (gameAccount.frameCount.toNumber() > 0) {
            console.log("\n✅ BACKEND IS WORKING! Frame count is updating.");
        } else {
            console.log("\n⚠️ Game may not be running - frame count is 0");
        }
    } catch (err) {
        console.error("Failed:", err);
    }
}

main();
