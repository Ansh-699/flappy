import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from "react";
import { PublicKey, Connection, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider, setProvider } from "@coral-xyz/anchor";
import { useSessionKeyManager } from "@magicblock-labs/gum-react-sdk";
import { type FlappyBird } from "../idl/flappy_bird";
import IDL from "../idl/flappy_bird.json";

// Game constants - must match Rust program
export const GAME_WIDTH = 600;
export const GAME_HEIGHT = 400;
export const BIRD_SIZE = 30;
export const PIPE_WIDTH = 60;
export const PIPE_GAP = 150;

// MagicBlock ER Validators
const ER_VALIDATORS = {
    ASIA: {
        identity: new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"),
        rpc: "https://devnet-as.magicblock.app",
        ws: "wss://devnet-as.magicblock.app",
    },
    EU: {
        identity: new PublicKey("MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e"),
        rpc: "https://devnet-eu.magicblock.app",
        ws: "wss://devnet-eu.magicblock.app",
    },
    US: {
        identity: new PublicKey("MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd"),
        rpc: "https://devnet-us.magicblock.app",
        ws: "wss://devnet-us.magicblock.app",
    },
} as const;

const DEFAULT_ER_VALIDATOR = ER_VALIDATORS.US;
const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

// Pipe data structure
export interface Pipe {
    x: number;
    gapY: number;
    passed: boolean;
    active: boolean;
}

// Game status enum matching Rust
export enum GameStatus {
    NotStarted = 0,
    Playing = 1,
    GameOver = 2,
}

// Game account data structure
export interface GameAccount {
    authority: PublicKey;
    score: number;
    highScore: number;
    gameStatus: GameStatus;
    birdY: number;        // Fixed-point, scaled by 1000
    birdVelocity: number; // Fixed-point, scaled by 1000
    frameCount: number;
    lastUpdate: number;
    pipes: Pipe[];
    nextPipeSpawnX: number;
    seed: number;
}

export type DelegationStatus = "undelegated" | "delegated" | "checking";

interface GameStateContextType {
    // Program and connection state
    program: Program<FlappyBird> | null;
    erProgram: Program<FlappyBird> | null;
    gamePubkey: PublicKey | null;
    
    // Game state
    gameAccount: GameAccount | null;
    erGameAccount: GameAccount | null;
    currentGameState: GameAccount | null;
    delegationStatus: DelegationStatus;
    
    // Loading states
    isLoading: boolean;
    isDelegating: boolean;
    isCheckingAccount: boolean;
    isInitialized: boolean | undefined;
    error: string | null;
    
    // Stats
    txCount: number;
    lastTxTime: number | null;
    
    // Base layer operations
    initialize: () => Promise<string>;
    
    // Game actions (run on ER when delegated)
    startGame: () => Promise<string>;
    flap: () => Promise<string>;
    tick: () => Promise<string>;
    endGame: () => Promise<string>;
    resetGame: () => Promise<string>;
    
    // ER management
    delegate: () => Promise<string>;
    commit: () => Promise<string>;
    undelegate: () => Promise<string>;
    
    // Session management
    createSession: () => Promise<any>;
    sessionToken: string | PublicKey | null;
    isSessionLoading: boolean;
    
    // Utilities
    refetch: () => Promise<void>;
    checkDelegation: () => Promise<void>;
}

const GameStateContext = createContext<GameStateContextType | null>(null);

export const useGameState = () => {
    const context = useContext(GameStateContext);
    if (!context) {
        throw new Error("useGameState must be used within GameStateProvider");
    }
    return context;
};

function resolveErValidatorByIdentity(identity: PublicKey) {
    const identityStr = identity.toBase58();
    for (const v of Object.values(ER_VALIDATORS)) {
        if (v.identity.toBase58() === identityStr) return v;
    }
    return null;
}

export const GameStateProvider = ({ children }: { children: React.ReactNode }) => {
    const { connection } = useConnection();
    const wallet = useWallet();
    
    const [gamePubkey, setGamePubkey] = useState<PublicKey | null>(null);
    const [gameAccount, setGameAccount] = useState<GameAccount | null>(null);
    const [erGameAccount, setErGameAccount] = useState<GameAccount | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isDelegating, setIsDelegating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [delegationStatus, setDelegationStatus] = useState<DelegationStatus>("checking");
    const [txCount, setTxCount] = useState(0);
    const [lastTxTime, setLastTxTime] = useState<number | null>(null);
    const [isCheckingAccount, setIsCheckingAccount] = useState(true);
    
    const [erRpcEndpoint, setErRpcEndpoint] = useState<string>(DEFAULT_ER_VALIDATOR.rpc);
    const [erWsEndpoint, setErWsEndpoint] = useState<string>(DEFAULT_ER_VALIDATOR.ws);
    const [erValidatorIdentity, setErValidatorIdentity] = useState<PublicKey>(DEFAULT_ER_VALIDATOR.identity);
    
    // Stable keypair for session wallet initialization when wallet not connected
    const [dummyKeypair] = useState(() => Keypair.generate());
    
    // Burner keypair for ER game operations - signs locally without popups!
    // This keypair is stored in useState to persist across renders
    // It's generated once per session and used for all ER game actions
    const [burnerKeypair] = useState(() => {
        // Try to restore from localStorage
        const stored = localStorage.getItem("erBurnerKeypair");
        if (stored) {
            try {
                const secretKey = new Uint8Array(JSON.parse(stored));
                const kp = Keypair.fromSecretKey(secretKey);
                console.log("[Burner] Restored keypair:", kp.publicKey.toBase58().substring(0, 8) + "...");
                return kp;
            } catch (e) {
                console.warn("[Burner] Failed to restore keypair, generating new one");
            }
        }
        const kp = Keypair.generate();
        localStorage.setItem("erBurnerKeypair", JSON.stringify(Array.from(kp.secretKey)));
        console.log("[Burner] Generated new keypair:", kp.publicKey.toBase58().substring(0, 8) + "...");
        return kp;
    });
    
    // Cache for ER blockhash to avoid fetching on every transaction
    const erBlockhashCache = useRef<{ blockhash: string; lastValidBlockHeight: number; fetchedAt: number } | null>(null);
    const BLOCKHASH_CACHE_MS = 10000; // Cache for 10 seconds (ER blockhashes are valid longer)
    
    // Pre-built transaction cache for high-frequency actions (tick/flap)
    // This avoids the slow transaction building on every call
    const txInstructionCache = useRef<{
        tick: { instruction: any; keys: any[] } | null;
        flap: { instruction: any; keys: any[] } | null;
    }>({ tick: null, flap: null });
    
    // Base layer Anchor provider and program
    const program = useMemo(() => {
        if (!wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) {
            return null;
        }

        const provider = new AnchorProvider(
            connection,
            {
                publicKey: wallet.publicKey,
                signTransaction: wallet.signTransaction,
                signAllTransactions: wallet.signAllTransactions,
            },
            { commitment: "confirmed" }
        );

        setProvider(provider);
        return new Program<FlappyBird>(IDL as FlappyBird, provider);
    }, [connection, wallet.publicKey, wallet.signTransaction, wallet.signAllTransactions]);

    // ER Connection
    const erConnection = useMemo(() => {
        return new Connection(erRpcEndpoint, {
            wsEndpoint: erWsEndpoint,
            commitment: "confirmed",
        });
    }, [erRpcEndpoint, erWsEndpoint]);

    // ER Provider
    const erProvider = useMemo(() => {
        if (!wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) {
            return null;
        }

        return new AnchorProvider(
            erConnection,
            {
                publicKey: wallet.publicKey,
                signTransaction: wallet.signTransaction,
                signAllTransactions: wallet.signAllTransactions,
            },
            { commitment: "confirmed" }
        );
    }, [erConnection, wallet.publicKey, wallet.signTransaction, wallet.signAllTransactions]);

    // ER Program
    const erProgram = useMemo(() => {
        if (!erProvider) {
            return null;
        }
        return new Program<FlappyBird>(IDL as FlappyBird, erProvider);
    }, [erProvider]);

    // Session Key Manager
    const sessionWallet = useSessionKeyManager(
        wallet.publicKey ? wallet : {
            ...wallet,
            publicKey: dummyKeypair.publicKey,
        } as any,
        connection,
        "devnet"
    );

    const sessionToken = sessionWallet.sessionToken;
    const isSessionLoading = sessionWallet.isLoading;

    const createSession = useCallback(async () => {
        console.log("[Session] Creating session for seamless gameplay...");
        return await sessionWallet.createSession(new PublicKey(IDL.address));
    }, [sessionWallet]);

    // Game seed must match Rust: pub const GAME_SEED: &[u8] = b"game_v2";
    const GAME_SEED = Buffer.from("game_v2");

    // Derive PDA from wallet public key
    const derivePDA = useCallback((authority: PublicKey) => {
        const [pda] = PublicKey.findProgramAddressSync(
            [GAME_SEED, authority.toBuffer()],
            new PublicKey(IDL.address)
        );
        return pda;
    }, []);

    // Parse game account data
    const parseGameAccount = useCallback((data: any): GameAccount => {
        const pipesData = data.pipes || [];
        const pipes: Pipe[] = pipesData.map((p: any) => ({
            x: Number(p.x),
            gapY: Number(p.gapY ?? p.gap_y),
            passed: Boolean(p.passed),
            active: Boolean(p.active),
        }));

        let status = GameStatus.NotStarted;
        const gameStatusData = data.gameStatus ?? data.game_status;
        if (gameStatusData) {
            if (typeof gameStatusData === 'object') {
                if ('playing' in gameStatusData || 'Playing' in gameStatusData) {
                    status = GameStatus.Playing;
                } else if ('gameOver' in gameStatusData || 'GameOver' in gameStatusData) {
                    status = GameStatus.GameOver;
                }
            } else if (typeof gameStatusData === 'number') {
                status = gameStatusData;
            }
        }

        return {
            authority: data.authority,
            score: Number(data.score ?? 0),
            highScore: Number(data.highScore ?? data.high_score ?? 0),
            gameStatus: status,
            birdY: Number(data.birdY ?? data.bird_y ?? GAME_HEIGHT * 500),
            birdVelocity: Number(data.birdVelocity ?? data.bird_velocity ?? 0),
            frameCount: Number(data.frameCount ?? data.frame_count ?? 0),
            lastUpdate: Number(data.lastUpdate ?? data.last_update ?? 0),
            pipes,
            nextPipeSpawnX: Number(data.nextPipeSpawnX ?? data.next_pipe_spawn_x ?? GAME_WIDTH),
            seed: Number(data.seed ?? 0),
        };
    }, []);

    // Auto-derive game PDA when wallet connects
    useEffect(() => {
        if (wallet.publicKey) {
            const pda = derivePDA(wallet.publicKey);
            console.log("[PDA] Derived game PDA:", pda.toBase58());
            setGamePubkey(pda);
        } else {
            setGamePubkey(null);
        }
    }, [wallet.publicKey, derivePDA]);

    // Resolve ER validator from delegation record
    useEffect(() => {
        if (!gamePubkey) return;

        let cancelled = false;
        (async () => {
            try {
                const seed = new TextEncoder().encode("delegation");
                const [delegationRecord] = PublicKey.findProgramAddressSync(
                    [seed, gamePubkey.toBytes()],
                    DELEGATION_PROGRAM_ID
                );
                const acc = await connection.getAccountInfo(delegationRecord, "confirmed");
                if (cancelled) return;

                const isDelegated =
                    acc !== null &&
                    acc.owner.equals(DELEGATION_PROGRAM_ID) &&
                    acc.lamports !== 0 &&
                    acc.data.length >= 40;

                if (!isDelegated) return;

                const validatorIdentity = new PublicKey(acc.data.subarray(8, 40));
                const v = resolveErValidatorByIdentity(validatorIdentity);
                if (!v) {
                    console.warn("[ER] Delegated to unknown validator:", validatorIdentity.toBase58());
                    return;
                }

                setErValidatorIdentity(v.identity);
                setErRpcEndpoint(v.rpc);
                setErWsEndpoint(v.ws);
                console.log("[ER] Using validator:", v.rpc, "identity:", v.identity.toBase58());
            } catch (e) {
                console.warn("[ER] Failed to resolve delegated validator:", e);
            }
        })();

        return () => { cancelled = true; };
    }, [connection, gamePubkey]);

    // Fetch game account from base layer
    const fetchGameAccount = useCallback(async () => {
        if (!program || !gamePubkey) {
            setGameAccount(null);
            setIsCheckingAccount(false);
            return;
        }

        try {
            console.log("[Base] Fetching game account:", gamePubkey.toBase58());
            const account = await program.account.gameState.fetch(gamePubkey);
            console.log("[Base] Game account found");
            setGameAccount(parseGameAccount(account));
            setError(null);
        } catch (err) {
            console.log("[Base] Game account not found - need to initialize");
            setGameAccount(null);
        } finally {
            setIsCheckingAccount(false);
        }
    }, [program, gamePubkey, parseGameAccount]);

    // Check delegation status
    const checkDelegationStatus = useCallback(async () => {
        if (!gamePubkey) {
            setDelegationStatus("checking");
            setIsCheckingAccount(false);
            return;
        }

        try {
            setDelegationStatus("checking");
            const accountInfo = await connection.getAccountInfo(gamePubkey);

            if (!accountInfo) {
                console.log("[Delegation] Account not found on base layer");
                setDelegationStatus("undelegated");
                setErGameAccount(null);
                setGameAccount(null);
                setIsCheckingAccount(false);
                return;
            }

            const isDelegated = accountInfo.owner.equals(DELEGATION_PROGRAM_ID);
            console.log("[Delegation] Owner:", accountInfo.owner.toBase58(), "isDelegated:", isDelegated);

            if (isDelegated) {
                if (erProgram) {
                    try {
                        const erAccountInfo = await erConnection.getAccountInfo(gamePubkey);
                        
                        if (!erAccountInfo || erAccountInfo.data.length === 0) {
                            console.log("[Delegation] ER account is empty");
                            setDelegationStatus("undelegated");
                            setErGameAccount(null);
                            setGameAccount(null);
                            setIsCheckingAccount(false);
                            return;
                        }
                        
                        const account = await erProgram.account.gameState.fetch(gamePubkey);
                        setErGameAccount(parseGameAccount(account));
                        setDelegationStatus("delegated");
                    } catch (err) {
                        console.log("[Delegation] Couldn't fetch from ER:", err);
                        setDelegationStatus("undelegated");
                        setErGameAccount(null);
                        setGameAccount(null);
                    }
                } else {
                    setDelegationStatus("delegated");
                }
            } else {
                setDelegationStatus("undelegated");
                setErGameAccount(null);
            }
        } catch (err) {
            console.debug("Error checking delegation:", err);
            setDelegationStatus("undelegated");
            setErGameAccount(null);
        } finally {
            setIsCheckingAccount(false);
        }
    }, [gamePubkey, connection, erConnection, erProgram, parseGameAccount]);

    // Subscribe to base layer account changes via WebSocket
    useEffect(() => {
        if (!program || !gamePubkey) {
            return;
        }

        fetchGameAccount();
        checkDelegationStatus();

        console.log("[Base] Setting up WebSocket subscription for:", gamePubkey.toBase58());
        
        const subscriptionId = connection.onAccountChange(
            gamePubkey,
            async (accountInfo) => {
                try {
                    if (accountInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
                        setDelegationStatus("delegated");
                    } else {
                        const decoded = program.coder.accounts.decode("gameState", accountInfo.data);
                        setGameAccount(parseGameAccount(decoded));
                        setDelegationStatus("undelegated");
                    }
                } catch (err) {
                    console.error("[Base] Failed to decode account data:", err);
                }
            },
            "confirmed"
        );

        return () => {
            console.log("[Base] Cleaning up WebSocket subscription");
            connection.removeAccountChangeListener(subscriptionId);
        };
    }, [program, gamePubkey, connection, fetchGameAccount, checkDelegationStatus, parseGameAccount]);

    // Subscribe to ER state changes via WebSocket (much faster than polling!)
    useEffect(() => {
        if (!erProgram || !gamePubkey || delegationStatus !== "delegated") {
            return;
        }

        let lastLogTime = 0;

        // Initial fetch
        (async () => {
            try {
                const account = await erProgram.account.gameState.fetch(gamePubkey);
                setErGameAccount(parseGameAccount(account));
                console.log("[ER WebSocket] Initial state fetched");
            } catch (err) {
                console.warn("[ER WebSocket] Initial fetch failed:", err);
            }
        })();

        // Subscribe to account changes via WebSocket
        console.log("[ER WebSocket] Subscribing to account changes for:", gamePubkey.toBase58().substring(0, 8) + "...");
        
        const subscriptionId = erConnection.onAccountChange(
            gamePubkey,
            (accountInfo) => {
                try {
                    // Decode the account data using the program's coder
                    const decoded = erProgram.coder.accounts.decode("gameState", accountInfo.data);
                    const parsed = parseGameAccount(decoded);
                    
                    // Log every second to avoid spam
                    const now = Date.now();
                    if (now - lastLogTime > 1000) {
                        console.log("[ER WebSocket] State update:", {
                            status: parsed.gameStatus,
                            score: parsed.score,
                            birdY: Math.round(parsed.birdY / 1000),
                            activePipes: parsed.pipes.filter(p => p.active).length,
                        });
                        lastLogTime = now;
                    }
                    
                    setErGameAccount(parsed);
                } catch (err) {
                    // Silently ignore decode errors
                }
            },
            "processed" // Use "processed" for lowest latency
        );

        return () => {
            console.log("[ER WebSocket] Unsubscribing from account changes");
            erConnection.removeAccountChangeListener(subscriptionId);
        };
    }, [erProgram, erConnection, gamePubkey, delegationStatus, parseGameAccount]);

    // ========================================
    // Game Actions
    // ========================================

    const initialize = useCallback(async (): Promise<string> => {
        if (!program || !wallet.publicKey) {
            throw new Error("Wallet not connected");
        }

        setIsLoading(true);
        setError(null);

        try {
            const tx = await program.methods
                .initialize()
                .accounts({
                    authority: wallet.publicKey,
                })
                .rpc();

            console.log("[Initialize] Transaction confirmed:", tx);
            
            // Wait a bit for the transaction to be finalized and account to be available
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Retry fetching the game account a few times
            for (let i = 0; i < 5; i++) {
                try {
                    console.log(`[Initialize] Fetching game account (attempt ${i + 1})...`);
                    const account = await program.account.gameState.fetch(gamePubkey!);
                    console.log("[Initialize] Game account found:", account);
                    setGameAccount(parseGameAccount(account));
                    setIsCheckingAccount(false);
                    return tx;
                } catch (fetchErr) {
                    console.log(`[Initialize] Account not yet available, waiting...`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
            
            // Fallback to regular fetch
            await fetchGameAccount();
            return tx;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to initialize game";
            setError(message);
            throw err;
        } finally {
            setIsLoading(false);
        }
    }, [program, wallet.publicKey, gamePubkey, fetchGameAccount, parseGameAccount]);

    // Perform ER action using session wallet from gum-react-sdk
    // The Rust program's SimpleGameAction allows any signer (for ER game actions)
    // Security: The account is delegated, so only ER can modify it
    const performErAction = useCallback(async (
        methodName: "startGame" | "flap" | "tick" | "endGame" | "resetGame",
        actionName: string
    ): Promise<string> => {
        if (!erProgram || !gamePubkey) {
            throw new Error("Game not initialized or not delegated");
        }

        const start = Date.now();
        
        // Don't set error state for high-frequency actions (flap/tick)
        const isHighFrequency = methodName === "tick" || methodName === "flap";
        if (!isHighFrequency) {
            setError(null);
        }

        try {
            // Determine signer: prefer session wallet (from gum-react-sdk), fall back to burner keypair
            const hasSession = sessionWallet?.sessionToken != null && 
                              sessionWallet?.publicKey != null &&
                              typeof sessionWallet.signAndSendTransaction === "function";
            
            // For session wallet, we use its publicKey; for burner, we use burnerKeypair
            const signerPubkey = hasSession ? sessionWallet.publicKey! : burnerKeypair.publicKey;

            const methodBuilder = erProgram.methods[methodName]();
            
            // Explicitly pass BOTH game (PDA) and signer accounts
            // Use 'as any' to bypass TypeScript's strict IDL typing for PDA accounts
            // This is necessary because the game PDA derivation requires game.authority
            // which creates a circular dependency that Anchor can't resolve automatically
            let tx = await methodBuilder.accounts({
                game: gamePubkey,
                signer: signerPubkey,
            } as any).transaction();
            tx.feePayer = signerPubkey;
            
            // For important actions, always get fresh blockhash to avoid duplicates
            // For tick/flap, use cached blockhash for speed
            const now = Date.now();
            if (!isHighFrequency || !erBlockhashCache.current || now - erBlockhashCache.current.fetchedAt > BLOCKHASH_CACHE_MS) {
                const fresh = await erConnection.getLatestBlockhash({ commitment: "confirmed" });
                erBlockhashCache.current = {
                    blockhash: fresh.blockhash,
                    lastValidBlockHeight: fresh.lastValidBlockHeight,
                    fetchedAt: now,
                };
            }
            
            // Store locally to avoid null reference issues
            const blockhashInfo = erBlockhashCache.current;
            tx.recentBlockhash = blockhashInfo.blockhash;
            tx.lastValidBlockHeight = blockhashInfo.lastValidBlockHeight;

            let txHash: string;
            
            if (!isHighFrequency) {
                console.log(`[ER] ${actionName} transaction details:`, {
                    method: methodName,
                    game: gamePubkey.toBase58(),
                    signer: signerPubkey.toBase58(),
                    feePayer: tx.feePayer?.toBase58(),
                    blockhash: tx.recentBlockhash,
                    hasSession,
                    sessionPubkey: sessionWallet?.publicKey?.toBase58(),
                });
            }
            
            if (hasSession && sessionWallet.signTransaction) {
                // Use session wallet to SIGN (not send) - then we send to ER ourselves
                // This avoids the blockhash mismatch since sessionWallet.signAndSendTransaction
                // sends to its own connection (devnet), not the ER validator
                if (!isHighFrequency) {
                    console.log(`[ER] ${actionName} signing with session wallet, sending to ER...`);
                }
                const signedTx = await sessionWallet.signTransaction(tx);
                txHash = await erConnection.sendRawTransaction(signedTx.serialize(), {
                    skipPreflight: true,
                });
                if (!isHighFrequency) {
                    console.log(`[ER] ${actionName} tx sent via session+ER:`, txHash.substring(0, 16) + "...");
                }
            } else {
                // Fall back to burner keypair - also NO POPUP (local signing)
                if (!isHighFrequency) {
                    console.log(`[ER] ${actionName} using burner keypair...`);
                }
                tx.sign(burnerKeypair);
                txHash = await erConnection.sendRawTransaction(tx.serialize(), {
                    skipPreflight: true,
                });
                if (!isHighFrequency) {
                    console.log(`[ER] ${actionName} tx sent via burner:`, txHash.substring(0, 16) + "...");
                }
            }
            
            // Wait for confirmation only on important actions (not tick/flap)
            if (!isHighFrequency) {
                const confirmation = await erConnection.confirmTransaction(
                    {
                        signature: txHash,
                        blockhash: blockhashInfo.blockhash,
                        lastValidBlockHeight: blockhashInfo.lastValidBlockHeight,
                    },
                    "confirmed"
                );
                
                if (confirmation.value.err) {
                    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
                }
                
                // Fetch updated state after confirmed action
                try {
                    const account = await erProgram.account.gameState.fetch(gamePubkey);
                    setErGameAccount(parseGameAccount(account));
                } catch {}
            }

            const duration = Date.now() - start;
            setLastTxTime(duration);
            setTxCount(prev => prev + 1);

            return txHash;
        } catch (err: any) {
            // Invalidate blockhash cache on error (might be stale)
            erBlockhashCache.current = null;
            
            if (!isHighFrequency) {
                // Extract detailed error message
                let errorMessage = `Failed to ${actionName} on ER`;
                
                // Try to get logs from the error
                if (err?.logs) {
                    console.error(`[ER] ${actionName} logs:`, err.logs);
                    errorMessage = err.logs.join('\n');
                } else if (err?.message) {
                    errorMessage = err.message;
                }
                
                // Try to simulate to get more error info
                try {
                    if (err?.transaction) {
                        const simResult = await erConnection.simulateTransaction(err.transaction);
                        if (simResult.value.err) {
                            console.error(`[ER] ${actionName} simulation error:`, simResult.value.err);
                            console.error(`[ER] ${actionName} simulation logs:`, simResult.value.logs);
                        }
                    }
                } catch (simErr) {
                    // Ignore simulation errors
                }
                
                console.error(`[ER] ${actionName} error:`, errorMessage, err);
            }
            throw err;
        }
    }, [erProgram, erConnection, gamePubkey, burnerKeypair, sessionWallet, parseGameAccount]);

    // Fast tick/flap using session wallet (signs locally, sends to ER)
    // Session wallet from gum-react-sdk signs without popups after session is created
    const sendFastAction = useCallback(async (methodName: "tick" | "flap") => {
        if (!erProgram || !gamePubkey) return;
        
        // Use session wallet - it signs locally without popups
        const hasSession = sessionWallet?.sessionToken != null && 
                          sessionWallet?.publicKey != null &&
                          typeof sessionWallet.signTransaction === "function";
        
        if (!hasSession) {
            console.warn(`[Fast] No session wallet for ${methodName}, skipping`);
            return;
        }
        
        const signerPubkey = sessionWallet.publicKey!;
        
        // Build instruction only once, cache it
        if (!txInstructionCache.current[methodName]) {
            try {
                const instruction = await erProgram.methods[methodName]()
                    .accounts({
                        game: gamePubkey,
                        signer: signerPubkey,
                    } as any)
                    .instruction();
                    
                txInstructionCache.current[methodName] = {
                    instruction,
                    keys: instruction.keys,
                };
                console.log(`[Fast] Cached ${methodName} instruction for session:`, signerPubkey.toBase58().substring(0, 8));
            } catch (err) {
                console.error(`[Fast] Failed to build ${methodName} instruction:`, err);
                return;
            }
        }
        
        // Use cached blockhash - refresh if stale
        const now = Date.now();
        if (!erBlockhashCache.current || now - erBlockhashCache.current.fetchedAt > BLOCKHASH_CACHE_MS) {
            try {
                const fresh = await erConnection.getLatestBlockhash({ commitment: "confirmed" });
                erBlockhashCache.current = {
                    blockhash: fresh.blockhash,
                    lastValidBlockHeight: fresh.lastValidBlockHeight,
                    fetchedAt: Date.now(),
                };
            } catch {
                return; // Can't get blockhash, skip
            }
        }
        
        // Build transaction
        const cached = txInstructionCache.current[methodName]!;
        const tx = new Transaction();
        tx.add(cached.instruction);
        tx.feePayer = signerPubkey;
        tx.recentBlockhash = erBlockhashCache.current.blockhash;
        tx.lastValidBlockHeight = erBlockhashCache.current.lastValidBlockHeight;
        
        try {
            // Sign with session wallet (local, no popup)
            const signedTx = await sessionWallet.signTransaction!(tx);
            
            // Send to ER ourselves (not through session wallet's connection)
            await erConnection.sendRawTransaction(signedTx.serialize(), { skipPreflight: true });
            setTxCount(prev => prev + 1);
        } catch {
            // Invalidate blockhash on error
            erBlockhashCache.current = null;
        }
    }, [erProgram, erConnection, gamePubkey, sessionWallet]);

    // Game actions
    const startGame = useCallback(async (): Promise<string> => {
        return performErAction("startGame", "start game");
    }, [performErAction]);

    // Use fast path for flap
    const flap = useCallback(async (): Promise<string> => {
        sendFastAction("flap");
        return "fire-and-forget";
    }, [sendFastAction]);

    // Use fast path for tick  
    const tick = useCallback(async (): Promise<string> => {
        sendFastAction("tick");
        return "fire-and-forget";
    }, [sendFastAction]);

    const endGame = useCallback(async (): Promise<string> => {
        return performErAction("endGame", "end game");
    }, [performErAction]);

    const resetGame = useCallback(async (): Promise<string> => {
        return performErAction("resetGame", "reset game");
    }, [performErAction]);

    // ER Management
    const delegate = useCallback(async (): Promise<string> => {
        if (!program || !wallet.publicKey) {
            throw new Error("Wallet not connected");
        }

        setIsLoading(true);
        setIsDelegating(true);
        setError(null);

        try {
            const tx = await program.methods
                .delegate()
                .accounts({
                    payer: wallet.publicKey,
                })
                .remainingAccounts([
                    {
                        pubkey: erValidatorIdentity,
                        isSigner: false,
                        isWritable: false,
                    },
                ])
                .rpc({ skipPreflight: true });

            await new Promise(resolve => setTimeout(resolve, 2000));
            await checkDelegationStatus();

            return tx;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to delegate game";
            setError(message);
            throw err;
        } finally {
            setIsLoading(false);
            setIsDelegating(false);
        }
    }, [program, wallet.publicKey, erValidatorIdentity, checkDelegationStatus]);

    const commit = useCallback(async (): Promise<string> => {
        if (!program || !erProvider || !wallet.publicKey || !gamePubkey) {
            throw new Error("Game not initialized or not delegated");
        }

        setIsLoading(true);
        setError(null);

        try {
            let tx = await program.methods
                .commit()
                .accounts({
                    payer: wallet.publicKey,
                })
                .transaction();

            tx.feePayer = wallet.publicKey;
            const erBlockhash = await erConnection.getLatestBlockhash({ commitment: "confirmed" });
            tx.recentBlockhash = erBlockhash.blockhash;
            tx.lastValidBlockHeight = erBlockhash.lastValidBlockHeight;
            tx = await erProvider.wallet.signTransaction(tx);

            const txHash = await erConnection.sendRawTransaction(tx.serialize(), {
                skipPreflight: true,
            });
            await erConnection.confirmTransaction(
                {
                    signature: txHash,
                    blockhash: erBlockhash.blockhash,
                    lastValidBlockHeight: erBlockhash.lastValidBlockHeight,
                },
                "confirmed"
            );

            await fetchGameAccount();
            return txHash;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to commit game";
            setError(message);
            throw err;
        } finally {
            setIsLoading(false);
        }
    }, [program, erProvider, erConnection, wallet.publicKey, gamePubkey, fetchGameAccount]);

    const undelegate = useCallback(async (): Promise<string> => {
        if (!program || !erProvider || !wallet.publicKey || !gamePubkey) {
            throw new Error("Game not initialized or not delegated");
        }

        setIsLoading(true);
        setError(null);

        try {
            let tx = await program.methods
                .undelegate()
                .accounts({
                    payer: wallet.publicKey,
                })
                .transaction();

            tx.feePayer = wallet.publicKey;
            const erBlockhash = await erConnection.getLatestBlockhash({ commitment: "confirmed" });
            tx.recentBlockhash = erBlockhash.blockhash;
            tx.lastValidBlockHeight = erBlockhash.lastValidBlockHeight;
            tx = await erProvider.wallet.signTransaction(tx);

            const txHash = await erConnection.sendRawTransaction(tx.serialize(), {
                skipPreflight: true,
            });
            await erConnection.confirmTransaction(
                {
                    signature: txHash,
                    blockhash: erBlockhash.blockhash,
                    lastValidBlockHeight: erBlockhash.lastValidBlockHeight,
                },
                "confirmed"
            );

            await new Promise(resolve => setTimeout(resolve, 2000));
            setDelegationStatus("undelegated");
            setErGameAccount(null);
            await fetchGameAccount();

            return txHash;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to undelegate game";
            setError(message);
            throw err;
        } finally {
            setIsLoading(false);
        }
    }, [program, erProvider, erConnection, wallet.publicKey, gamePubkey, fetchGameAccount]);

    // Computed values
    const currentGameState = useMemo(() => {
        if (delegationStatus === "delegated" && erGameAccount) {
            return erGameAccount;
        }
        return gameAccount;
    }, [delegationStatus, erGameAccount, gameAccount]);

    const isInitialized = useMemo(() => {
        if (isCheckingAccount) return undefined;
        return gameAccount !== null || (delegationStatus === "delegated" && erGameAccount !== null);
    }, [isCheckingAccount, gameAccount, delegationStatus, erGameAccount]);

    const value: GameStateContextType = {
        program,
        erProgram,
        gamePubkey,
        gameAccount,
        erGameAccount,
        currentGameState,
        delegationStatus,
        isLoading,
        isDelegating,
        isCheckingAccount,
        isInitialized,
        error,
        txCount,
        lastTxTime,
        initialize,
        startGame,
        flap,
        tick,
        endGame,
        resetGame,
        delegate,
        commit,
        undelegate,
        createSession,
        sessionToken,
        isSessionLoading,
        refetch: fetchGameAccount,
        checkDelegation: checkDelegationStatus,
    };

    return (
        <GameStateContext.Provider value={value}>
            {children}
        </GameStateContext.Provider>
    );
};
