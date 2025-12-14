
import { Connection, PublicKey } from "@solana/web3.js";

const ER_ENDPOINT = "https://devnet-as.magicblock.app";

// From user logs (Step 100)
const GAME_PDA = new PublicKey("AXHuZDSoMba4zExpDHWp86MTNVhbjUyJh7yujDW4JmDf");
// const SIGNER = new PublicKey("5gvGcuE57LDsaBAzHHPTc8n5YfowWdZEdteKrTBTEHbr");
// const SESSION_TOKEN = new PublicKey("33mBCWk3UZedMDc7XvjjJXMX19CP3RcNboUtj5WYS33r");

// Let's also check the ones from previous run just in case (C2YPR...) 
// But AXHu... is the latest.

const ACCOUNTS_TO_CHECK = [
    { name: "Game PDA", pubkey: GAME_PDA },
    { name: "Signer", pubkey: new PublicKey("5gvGcuE57LDsaBAzHHPTc8n5YfowWdZEdteKrTBTEHbr") },
    { name: "Session Token", pubkey: new PublicKey("33mBCWk3UZedMDc7XvjjJXMX19CP3RcNboUtj5WYS33r") },
    { name: "Program ID", pubkey: new PublicKey("DfJtsSqWNSetyRr3Fj4ZxM44oSBuZzAh4MTFMHQJSWvj") }
];

async function main() {
    const connection = new Connection(ER_ENDPOINT, "confirmed");

    console.log("Inspecting accounts on ER:", ER_ENDPOINT);

    for (const acc of ACCOUNTS_TO_CHECK) {
        console.log(`\nChecking ${acc.name} (${acc.pubkey.toString()})...`);
        try {
            const info = await connection.getAccountInfo(acc.pubkey);
            if (!info) {
                console.log("  ❌ Account NOT FOUND (null)");
            } else {
                console.log("  ✅ Account Exists!");
                console.log("     Owner:", info.owner.toString());
                console.log("     Lamports:", info.lamports);
                console.log("     Data Len:", info.data.length);
                console.log("     Executable:", info.executable);
            }
        } catch (e) {
            console.error("  Error fetching:", e.message);
        }
    }
}

main();
