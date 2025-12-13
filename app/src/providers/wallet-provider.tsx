import { useMemo, type ReactNode } from "react";
import {
    ConnectionProvider,
    WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";

// ========================================
// NETWORK CONFIGURATION - Toggle between localnet and devnet
// ========================================
const USE_LOCALNET = false; // Set to false for devnet (session keys work here)

// Localnet configuration (base layer validator)
// Use 127.0.0.1 instead of localhost for better Firefox CORS support
const LOCALNET_ENDPOINT = "http://127.0.0.1:8899";
const LOCALNET_WS_ENDPOINT = "ws://127.0.0.1:8900";

// Devnet configuration (Helius RPC for better performance)
const DEVNET_ENDPOINT = "https://devnet.helius-rpc.com/?api-key=dcef7561-099a-485b-9fe1-740a9e4da91e";
const DEVNET_WS_ENDPOINT = "wss://devnet.helius-rpc.com/?api-key=dcef7561-099a-485b-9fe1-740a9e4da91e";

// Select based on network
const RPC_ENDPOINT = USE_LOCALNET ? LOCALNET_ENDPOINT : DEVNET_ENDPOINT;
const WS_ENDPOINT = USE_LOCALNET ? LOCALNET_WS_ENDPOINT : DEVNET_WS_ENDPOINT;

interface WalletProviderProps {
    children: ReactNode;
}

/**
 * Wallet Provider that wraps the Solana wallet adapter providers.
 * Network: ${USE_LOCALNET ? "LOCALNET" : "DEVNET"}
 */
export function WalletProvider({ children }: WalletProviderProps) {
    const config = useMemo(
        () => ({
            wsEndpoint: WS_ENDPOINT,
            commitment: "confirmed" as const,
        }),
        []
    );

    console.log(`[WalletProvider] Network: ${USE_LOCALNET ? "LOCALNET" : "DEVNET"}`, "RPC:", RPC_ENDPOINT);

    return (
        <ConnectionProvider endpoint={RPC_ENDPOINT} config={config}>
            <SolanaWalletProvider wallets={[]} autoConnect>
                <WalletModalProvider>{children}</WalletModalProvider>
            </SolanaWalletProvider>
        </ConnectionProvider>
    );
}
