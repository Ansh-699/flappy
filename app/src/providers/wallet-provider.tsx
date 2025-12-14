import { useMemo, type ReactNode } from "react";
import {
    ConnectionProvider,
    WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { GameStateProvider } from "./GameStateProvider";
import "@solana/wallet-adapter-react-ui/styles.css";

// ========================================
// NETWORK CONFIGURATION - Toggle between localnet and devnet
// ========================================
const USE_LOCALNET = false; // Devnet

// Localnet configuration (base layer validator)
// Use 127.0.0.1 instead of localhost for better Firefox CORS support
const LOCALNET_ENDPOINT = "http://127.0.0.1:8899";
const LOCALNET_WS_ENDPOINT = "ws://127.0.0.1:8900";

// Devnet configuration
const DEVNET_ENDPOINT = "https://api.devnet.solana.com";
const DEVNET_WS_ENDPOINT = "wss://api.devnet.solana.com";

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
    const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

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
            <SolanaWalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider>
                    <GameStateProvider>
                        {children}
                    </GameStateProvider>
                </WalletModalProvider>
            </SolanaWalletProvider>
        </ConnectionProvider>
    );
}
