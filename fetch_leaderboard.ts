import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";

// Load IDL
const idlPath = path.resolve("target/idl/flappy_bird.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

// Config
const PROGRAM_ID = new PublicKey("DfJtsSqWNSetyRr3Fj4ZxM44oSBuZzAh4MTFMHQJSWvj");
const DEVNET_ENDPOINT = "https://api.devnet.solana.com";

async function main() {
    console.log("Fetching leaderboard from Devnet...");

    const connection = new Connection(DEVNET_ENDPOINT, "confirmed");
    // Dummy wallet for read-only
    const wallet = {
        publicKey: new PublicKey("11111111111111111111111111111111"),
        signTransaction: async () => { throw new Error("Read only"); },
        signAllTransactions: async () => { throw new Error("Read only"); }
    };

    const provider = new AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
    const program = new Program(idl, provider);

    try {
        const accounts = await program.account.gameState.all();
        console.log(`Found ${accounts.length} game accounts.`);

        const sorted = accounts.map(acc => ({
            pubkey: acc.publicKey.toString(),
            authority: acc.account.authority.toString(),
            score: Number(acc.account.score),
            highScore: Number(acc.account.highScore)
        }))
            .sort((a, b) => b.highScore - a.highScore)
            .slice(0, 10);

        console.log("\nTop 10 High Scores:");
        console.log("----------------------------------------------------------------");
        console.log("Rank | Score | Authority                                | Game PDA");
        console.log("----------------------------------------------------------------");
        sorted.forEach((acc, i) => {
            console.log(`${(i + 1).toString().padEnd(4)} | ${acc.highScore.toString().padEnd(5)} | ${acc.authority.padEnd(40)} | ${acc.pubkey}`);
        });
        console.log("----------------------------------------------------------------");

    } catch (e) {
        console.error("Error:", e);
    }
}

main();
