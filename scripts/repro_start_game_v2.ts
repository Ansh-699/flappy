
import { Connection, PublicKey, Keypair, Transaction, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import * as borsh from "@coral-xyz/borsh";

// Config
const ER_ENDPOINT = "https://devnet-as.magicblock.app";
const PROGRAM_ID = new PublicKey("DfJtsSqWNSetyRr3Fj4ZxM44oSBuZzAh4MTFMHQJSWvj");
const GAME_SEED = Buffer.from("game_v2");

// const TEST_WALLET = Keypair.generate();
// Load from ~/.config/solana/id.json
const keypairData = JSON.parse(readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8"));
const TEST_WALLET = Keypair.fromSecretKey(Uint8Array.from(keypairData));

const [gamePDA] = PublicKey.findProgramAddressSync(
    [GAME_SEED, TEST_WALLET.publicKey.toBuffer()],
    PROGRAM_ID
);

console.log("---------------------------------------------------------");
console.log("🧪 REPRO V2 (Funded)");
console.log("---------------------------------------------------------");

// HELPER: Validate discriminator
function getDiscriminator(name: string) {
    const hash = createHash("sha256").update(`global:${name}`).digest();
    return hash.slice(0, 8);
}

async function main() {
    const connection = new Connection(ER_ENDPOINT, "confirmed");
    console.log("Wallet:", TEST_WALLET.publicKey.toString());

    // FUND WALLET ACROSS BOTH NETWORKS (Just in case)
    console.log("0. Check Funding...");
    const currentBal = await connection.getBalance(TEST_WALLET.publicKey);
    if (currentBal >= 1000000) {
        console.log(`   -> Already funded: ${currentBal}`);
    } else {
        console.log("   -> Needs funding...");
        let funded = false;
        for (let i = 0; i < 5; i++) {
            try {
                const devConnection = new Connection("https://api.devnet.solana.com", "confirmed");
                const sig = await devConnection.requestAirdrop(TEST_WALLET.publicKey, 1000000000);
                await devConnection.confirmTransaction(sig, "confirmed");
                console.log("   -> Funded on Devnet.");
                funded = true;
                break;
            } catch (e) {
                console.error(`   -> Funding attempt ${i + 1} failed:`, e.message);
                await new Promise(r => setTimeout(r, 2000 * (i + 1)));
            }
        }

        if (!funded) {
            console.log("   ⚠️ Warning: Airdrop failed. Script might fail if wallet has no funds.");
        } else {
            // Wait for mirror
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    try {
        const bal = await connection.getBalance(TEST_WALLET.publicKey);
        console.log(`   -> ER Balance: ${bal}`);
    } catch (e) { console.log("   -> ER Balance Check Failed"); }

    console.log("1. Initialize...");
    try {
        // Build Initialize Instruction manually
        // Accounts: [game(writable), authority(signer, writable), systemProgram]
        const discriminator = getDiscriminator("initialize");

        const ix = new TransactionInstruction({
            keys: [
                { pubkey: gamePDA, isSigner: false, isWritable: true },
                { pubkey: TEST_WALLET.publicKey, isSigner: true, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
            ],
            programId: PROGRAM_ID,
            data: discriminator
        });

        const tx = new Transaction().add(ix);
        tx.feePayer = TEST_WALLET.publicKey;
        // tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        // On ER, sometimes getLatestBlockhash is tricky? No, should work.
        const bh = await connection.getLatestBlockhash();
        tx.recentBlockhash = bh.blockhash;

        tx.sign(TEST_WALLET);

        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        console.log("   -> Sent:", sig);
        const confirmation = await connection.confirmTransaction(sig, "confirmed");
        if (confirmation.value.err) {
            console.error("   ❌ Init Transaction Failed:", JSON.stringify(confirmation.value.err));
        } else {
            console.log("   -> Confirmed.");
        }
    } catch (e) {
        console.log("   -> Init Failed:", e.message);
    }

    // Verify account
    const acc = await connection.getAccountInfo(gamePDA);
    if (!acc) {
        console.log("   ❌ Game Account NOT FOUND. Init failed silently?");
    } else {
        console.log("   ✅ Game Account Exists. Len:", acc.data.length);

        console.log("2. Start Game...");
        try {
            // Accounts: [game(writable), signer(signer), sessionToken(optional)]
            const startDisc = getDiscriminator("start_game");

            // WE TRY WITHOUT SESSION TOKEN FIRST
            const ix = new TransactionInstruction({
                keys: [
                    { pubkey: gamePDA, isSigner: false, isWritable: true },
                    { pubkey: TEST_WALLET.publicKey, isSigner: true, isWritable: true }, // Signer/Payer
                    // sessionToken null? 
                    // Anchor handles Option<Account> by just not including it if None? 
                    // Or including it with a specific prefix?
                    // In raw instruction, Account Option is usually implemented as:
                    // If Some: key is present. If None: key is NOT present? 
                    // Or maybe there is a 'has_session' byte in data? No, accounts can't be optional in keys list index unless realloc?
                    // Actually, Anchor puts optional accounts at the end.
                    // If we pass null, we usually pass `programId` (SystemProgram) as placeholder?
                    // Let's pass NO session token key.
                ],
                programId: PROGRAM_ID,
                data: startDisc
            });

            const tx = new Transaction().add(ix);
            tx.feePayer = TEST_WALLET.publicKey;
            tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
            tx.sign(TEST_WALLET);

            const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
            console.log("   -> Start Sent:", sig);
            const res = await connection.confirmTransaction(sig, "confirmed");
            if (res.value.err) {
                console.log("   ❌ Start Transaction Failed:", JSON.stringify(res.value.err));
            } else {
                console.log("   ✅ Start Success!");
            }

        } catch (e) {
            console.log("   -> Start Error:", e);
        }
    }
}

main();
