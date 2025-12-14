import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider, setProvider } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, Transaction } from "@solana/web3.js";
import { type FlappyBird } from "../idl/flappy_bird";
import IDL from "../idl/flappy_bird.json";
import { useSessionKeyManager } from "@magicblock-labs/gum-react-sdk";

// Game constants matching the Rust program
export const GAME_WIDTH = 600;
export const GAME_HEIGHT = 400;
export const BIRD_SIZE = 30;
export const BIRD_X = 50;
export const PIPE_WIDTH = 60;
export const PIPE_GAP = 150;

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

// MagicBlock public devnet ER validators (docs.magicblock.gg -> ER -> Local Development)
// IMPORTANT: Your account must be delegated to the same validator you send ER txs to.
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

function resolveErValidatorByIdentity(identity: PublicKey) {
    const identityStr = identity.toBase58();
    for (const v of Object.values(ER_VALIDATORS)) {
        if (v.identity.toBase58() === identityStr) return v;
    }
    return null;
}

// Delegation status
export type DelegationStatus = "undelegated" | "delegated" | "checking";

/**
 * Hook to interact with the on-chain Flappy Bird game.
 * All game logic runs on-chain with MagicBlock Ephemeral Rollups for low latency.
 */
export function useOnChainFlappyBird() {
    const { connection } = useConnection();
    const wallet = useWallet();

    const [gamePubkey, setGamePubkey] = useState<PublicKey | null>(null);
    const [gameAccount, setGameAccount] = useState<GameAccount | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isDelegating, setIsDelegating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [delegationStatus, setDelegationStatus] = useState<DelegationStatus>("checking");
    const [erGameAccount, setErGameAccount] = useState<GameAccount | null>(null);
    const [txCount, setTxCount] = useState(0);
    const [lastTxTime, setLastTxTime] = useState<number | null>(null);
    const [isCheckingAccount, setIsCheckingAccount] = useState(true); // True while checking if account exists

    const [erRpcEndpoint, setErRpcEndpoint] = useState<string>(DEFAULT_ER_VALIDATOR.rpc);
    const [erWsEndpoint, setErWsEndpoint] = useState<string>(DEFAULT_ER_VALIDATOR.ws);
    const [erValidatorIdentity, setErValidatorIdentity] = useState<PublicKey | null>(DEFAULT_ER_VALIDATOR.identity);

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

    // Resolve which ER validator this game is delegated to (from base-layer delegation record PDA)
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

                // Delegation record layout: validator identity pubkey at bytes [8..40]
                const validatorIdentity = new PublicKey(acc.data.subarray(8, 40));
                const v = resolveErValidatorByIdentity(validatorIdentity);
                if (!v) {
                    console.warn(
                        "[ER] Delegated to unknown validator identity:",
                        validatorIdentity.toBase58(),
                        "(keeping current ER endpoint)")
                    return;
                }

                setErValidatorIdentity(v.identity);
                setErRpcEndpoint(v.rpc);
                setErWsEndpoint(v.ws);
                console.log("[ER] Using validator:", v.rpc, "identity:", v.identity.toBase58());
            } catch (e) {
                console.warn("[ER] Failed to resolve delegated validator; keeping current ER endpoint", e);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [connection, gamePubkey]);

    // Ephemeral Rollup connection and provider
    const erConnection = useMemo(() => {
        return new Connection(erRpcEndpoint, {
            wsEndpoint: erWsEndpoint,
            commitment: "confirmed",
        });
    }, [erRpcEndpoint, erWsEndpoint]);

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

    const erProgram = useMemo(() => {
        if (!erProvider) {
            return null;
        }

        return new Program<FlappyBird>(IDL as FlappyBird, erProvider);
    }, [erProvider]);

    // Session Key Manager for seamless transactions on devnet
    // This enables auto-approval of transactions after initial session creation
    // gum-react-sdk can crash when wallet.publicKey is null on first render.
    // Provide a stable dummy keypair until the wallet connects.
    const [dummyKeypair] = useState(() => Keypair.generate());
    
    const sessionWallet = useSessionKeyManager(
        wallet.publicKey ? wallet : {
            ...wallet,
            publicKey: dummyKeypair.publicKey,
        } as any,
        connection,
        "devnet"
    );

    // Use session keys for seamless gameplay
    const sessionToken = sessionWallet.sessionToken;
    const isSessionLoading = sessionWallet.isLoading;

    const createSession = useCallback(async () => {
        console.log("[Session] Creating session for seamless gameplay...");
        return await sessionWallet.createSession(new PublicKey(IDL.address));
    }, [sessionWallet]);

    // Derive PDA from wallet public key
    const derivePDA = useCallback((authority: PublicKey) => {
        const [pda] = PublicKey.findProgramAddressSync(
            [authority.toBuffer()],
            new PublicKey(IDL.address)
        );
        return pda;
    }, []);

    // Parse game account data - handle both snake_case (from raw IDL) and camelCase
    const parseGameAccount = useCallback((data: any): GameAccount => {
        const pipesData = data.pipes || [];
        const pipes: Pipe[] = pipesData.map((p: any) => ({
            x: Number(p.x),
            gapY: Number(p.gapY ?? p.gap_y),
            passed: Boolean(p.passed),
            active: Boolean(p.active),
        }));

        // Parse game status - handle the Anchor enum format
        let status = GameStatus.NotStarted;
        const gameStatusData = data.gameStatus ?? data.game_status;
        if (gameStatusData) {
            if (typeof gameStatusData === 'object') {
                // Anchor enum format: { playing: {} } or { gameOver: {} } or { notStarted: {} }
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
            setGamePubkey(pda);
        } else {
            setGamePubkey(null);
        }
    }, [wallet.publicKey, derivePDA]);

    // Fetch game account data from base layer
    const fetchGameAccount = useCallback(async () => {
        if (!program || !gamePubkey) {
            setGameAccount(null);
            setIsCheckingAccount(false);
            return;
        }

        try {
            console.log("[Base] Fetching game account from base layer:", gamePubkey.toBase58());
            const account = await program.account.gameState.fetch(gamePubkey);
            console.log("[Base] Game account found:", account);
            setGameAccount(parseGameAccount(account));
            setError(null);
        } catch (err) {
            console.log("[Base] Game account not found on base layer - need to initialize");
            setGameAccount(null);
        } finally {
            setIsCheckingAccount(false);
        }
    }, [program, gamePubkey, parseGameAccount]);

    // Delegation Program address
    const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

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
            console.log("[Delegation] Base layer owner:", accountInfo.owner.toBase58(), "isDelegated:", isDelegated);

            if (isDelegated) {
                // Account is delegated - try to fetch from ER
                if (erProgram) {
                    try {
                        const erAccountInfo = await erConnection.getAccountInfo(gamePubkey);
                        console.log("[Delegation] ER account info:", erAccountInfo ? `${erAccountInfo.lamports} lamports, ${erAccountInfo.data.length} bytes` : "null");
                        
                        // Check if ER has actual data (not just empty account)
                        if (!erAccountInfo || erAccountInfo.data.length === 0 || erAccountInfo.lamports === 0) {
                            console.log("[Delegation] ER account is empty - need to re-initialize and re-delegate");
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
                        console.log("[Delegation] Couldn't fetch game from ER, treating as undelegated:", err);
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
            console.debug("Error checking delegation status:", err);
            setDelegationStatus("undelegated");
            setErGameAccount(null);
        } finally {
            setIsCheckingAccount(false);
        }
    }, [gamePubkey, connection, erConnection, erProgram, parseGameAccount]);

    // Subscribe to base layer account changes
    useEffect(() => {
        if (!program || !gamePubkey) {
            return;
        }

        fetchGameAccount();
        checkDelegationStatus();

        const subscriptionId = connection.onAccountChange(
            gamePubkey,
            async (accountInfo) => {
                try {
                    // Check if delegated
                    if (accountInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
                        setDelegationStatus("delegated");
                    } else {
                        const decoded = program.coder.accounts.decode("gameState", accountInfo.data);
                        setGameAccount(parseGameAccount(decoded));
                        setDelegationStatus("undelegated");
                    }
                } catch (err) {
                    console.error("Failed to decode account data:", err);
                }
            },
            "confirmed"
        );

        return () => {
            connection.removeAccountChangeListener(subscriptionId);
        };
    }, [program, gamePubkey, connection, fetchGameAccount, checkDelegationStatus, parseGameAccount]);

    // Subscribe to ER account changes when delegated
    useEffect(() => {
        if (!erProgram || !gamePubkey || delegationStatus !== "delegated") {
            return;
        }

        // Initial fetch from ER
        const fetchERState = async () => {
            try {
                console.log("[ER] Fetching game state from:", gamePubkey.toString());
                const account = await erProgram.account.gameState.fetch(gamePubkey);
                const parsed = parseGameAccount(account);
                console.log("[ER] Fetched game state:", {
                    status: parsed.gameStatus,
                    score: parsed.score,
                    birdY: parsed.birdY / 1000,
                    velocity: parsed.birdVelocity / 1000,
                    frameCount: parsed.frameCount,
                    activePipes: parsed.pipes.filter(p => p.active).length,
                });
                setErGameAccount(parsed);
            } catch (err) {
                console.error("[ER] Failed to fetch game state from", gamePubkey.toString(), ":", err);
            }
        };
        fetchERState();

        console.log("[ER] Setting up WebSocket subscription for:", gamePubkey.toBase58());
        
        const subscriptionId = erConnection.onAccountChange(
            gamePubkey,
            async (accountInfo) => {
                try {
                    const decoded = erProgram.coder.accounts.decode("gameState", accountInfo.data);
                    const parsed = parseGameAccount(decoded);
                    console.log("[ER] State update - status:", parsed.gameStatus, "score:", parsed.score, "birdY:", parsed.birdY / 1000);
                    setErGameAccount(parsed);
                } catch (err) {
                    console.error("[ER] Failed to decode account data:", err);
                }
            },
            "confirmed"
        );

        console.log("[ER] WebSocket subscription active, id:", subscriptionId);

        return () => {
            console.log("[ER] Cleaning up WebSocket subscription:", subscriptionId);
            erConnection.removeAccountChangeListener(subscriptionId);
        };
    }, [erProgram, gamePubkey, erConnection, delegationStatus, parseGameAccount]);

    // Helper to perform ER actions
    // NOTE: Session keys are disabled for ER - the ER doesn't support session signers that don't exist on-chain
    // The ER is fast enough (~300ms) that wallet signing is acceptable for now
    const performErAction = useCallback(async (
        methodName: "startGame" | "flap" | "tick" | "endGame" | "resetGame",
        actionName: string
    ): Promise<string> => {
        if (!erProgram || !erProvider || !wallet.publicKey || !gamePubkey) {
            throw new Error("Game not initialized or not delegated");
        }

        const start = Date.now();
        setError(null);

        try {
            // Always use wallet for signing on ER
            const signer = wallet.publicKey;
            
            console.log(`[ER] ${actionName} - using wallet as signer:`, signer.toString().substring(0, 8) + "...");

            // Build the method call using the ER program
            const methodBuilder = erProgram.methods[methodName]();
            
            // Build accounts
            // NOTE: Anchor browser builds can be strict about optional accounts;
            // pass `sessionToken: null` explicitly to satisfy `validateAccounts`.
            const accounts: any = {
                game: gamePubkey,
                signer: signer,
                sessionToken: null,
            };

            let tx = await methodBuilder
                .accounts(accounts)
                .transaction();

            tx.feePayer = wallet.publicKey;
            const erBlockhash = await erConnection.getLatestBlockhash({ commitment: "confirmed" });
            tx.recentBlockhash = erBlockhash.blockhash;
            tx.lastValidBlockHeight = erBlockhash.lastValidBlockHeight;

            // Sign with wallet
            tx = await erProvider.wallet.signTransaction(tx);

            const txHash = await erConnection.sendRawTransaction(tx.serialize(), {
                skipPreflight: true,
            });
            
            console.log(`[ER] ${actionName} tx sent:`, txHash.substring(0, 16) + "...");
            
            // Wait for confirmation on all transactions to ensure state is updated
            const confirmation = await erConnection.confirmTransaction(
                {
                    signature: txHash,
                    blockhash: erBlockhash.blockhash,
                    lastValidBlockHeight: erBlockhash.lastValidBlockHeight,
                },
                "confirmed"
            );
            console.log(`[ER] ${actionName} confirmed:`, confirmation.value.err ? "ERROR" : "OK");
            
            if (confirmation.value.err) {
                console.error(`[ER] ${actionName} transaction error:`, confirmation.value.err);
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }
            
            // Fetch updated state immediately after confirmation
            try {
                const account = await erProgram.account.gameState.fetch(gamePubkey);
                console.log(`[ER] Raw account after ${actionName}:`, {
                    birdY: account.birdY?.toString(),
                    birdVelocity: account.birdVelocity?.toString(),
                    gameStatus: account.gameStatus,
                    score: account.score?.toString(),
                    frameCount: account.frameCount?.toString(),
                });
                const parsed = parseGameAccount(account);
                console.log(`[ER] Parsed state after ${actionName}:`, {
                    birdY: parsed.birdY / 1000,
                    velocity: parsed.birdVelocity / 1000,
                    status: parsed.gameStatus,
                    score: parsed.score,
                    frameCount: parsed.frameCount,
                    activePipes: parsed.pipes.filter(p => p.active).length,
                });
                setErGameAccount(parsed);
            } catch (fetchErr) {
                console.error("Failed to fetch state after action:", fetchErr);
            }

            const duration = Date.now() - start;
            setLastTxTime(duration);
            setTxCount(prev => prev + 1);

            console.log(`${actionName} on ER: ${duration}ms, tx: ${txHash}`);
            return txHash;
        } catch (err) {
            const message = err instanceof Error ? err.message : `Failed to ${actionName} on ER`;
            console.error(`${actionName} error:`, err);
            throw err;
        }
    }, [erProgram, erProvider, erConnection, wallet.publicKey, gamePubkey, sessionToken, sessionWallet, parseGameAccount]);

    // ========================================
    // Base Layer Operations
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

            await fetchGameAccount();
            return tx;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to initialize game";
            setError(message);
            throw err;
        } finally {
            setIsLoading(false);
        }
    }, [program, wallet.publicKey, fetchGameAccount]);

    // ========================================
    // Game Actions on ER (main gameplay)
    // ========================================

    const startGame = useCallback(async (): Promise<string> => {
        if (!erProgram) throw new Error("ER Program not loaded");
        return performErAction("startGame", "start game");
    }, [erProgram, performErAction]);

    // Fast flap - uses session keys for seamless gameplay
    const flap = useCallback(async (): Promise<string> => {
        if (!erProgram || !erProvider || !wallet.publicKey || !gamePubkey) {
            throw new Error("Game not initialized or not delegated");
        }

        try {
            // Check if session keys are available
            const hasSession = sessionToken != null && 
                              sessionWallet != null && 
                              sessionWallet.publicKey != null && 
                              sessionWallet.signTransaction != null;
            
            const signer = hasSession ? sessionWallet.publicKey! : wallet.publicKey;

            const accounts: any = {
                game: gamePubkey,
                signer: signer,
            };
            
            // Optional account: set explicitly for consistent Anchor validation
            accounts.sessionToken = hasSession ? sessionToken : null;

            let tx = await erProgram.methods.flap()
                .accounts(accounts)
                .transaction();

            tx.feePayer = signer;
            const erBlockhash = await erConnection.getLatestBlockhash({ commitment: "confirmed" });
            tx.recentBlockhash = erBlockhash.blockhash;
            tx.lastValidBlockHeight = erBlockhash.lastValidBlockHeight;
            
            // Sign with session key or wallet
            if (hasSession) {
                tx = await sessionWallet.signTransaction!(tx);
            } else {
                tx = await erProvider.wallet.signTransaction(tx);
            }

            // Fire and forget
            const txHash = await erConnection.sendRawTransaction(tx.serialize(), {
                skipPreflight: true,
            });
            
            setTxCount(prev => prev + 1);
            return txHash;
        } catch (err) {
            console.error("[Flap] error:", err);
            throw err;
        }
    }, [erProgram, erProvider, erConnection, wallet.publicKey, gamePubkey, sessionToken, sessionWallet]);

    // Fast tick - uses session keys for seamless gameplay
    // The WebSocket subscription will update state automatically
    const tick = useCallback(async (): Promise<string> => {
        if (!erProgram || !erProvider || !wallet.publicKey || !gamePubkey) {
            throw new Error("Game not initialized or not delegated");
        }

        try {
            // Check if session keys are available
            const hasSession = sessionToken != null && 
                              sessionWallet != null && 
                              sessionWallet.publicKey != null && 
                              sessionWallet.signTransaction != null;
            
            const signer = hasSession ? sessionWallet.publicKey! : wallet.publicKey;

            const accounts: any = {
                game: gamePubkey,
                signer: signer,
            };
            
            // Optional account: set explicitly for consistent Anchor validation
            accounts.sessionToken = hasSession ? sessionToken : null;

            let tx = await erProgram.methods.tick()
                .accounts(accounts)
                .transaction();

            tx.feePayer = signer;
            const erBlockhash = await erConnection.getLatestBlockhash({ commitment: "confirmed" });
            tx.recentBlockhash = erBlockhash.blockhash;
            tx.lastValidBlockHeight = erBlockhash.lastValidBlockHeight;
            
            // Sign with session key or wallet
            if (hasSession) {
                tx = await sessionWallet.signTransaction!(tx);
            } else {
                tx = await erProvider.wallet.signTransaction(tx);
            }

            // Fire and forget - don't wait for confirmation
            const txHash = await erConnection.sendRawTransaction(tx.serialize(), {
                skipPreflight: true,
            });
            
            return txHash;
        } catch (err) {
            // Silently ignore tick errors during gameplay
            console.debug("[Tick] error:", err);
            return "";
        }
    }, [erProgram, erProvider, erConnection, wallet.publicKey, gamePubkey, sessionToken, sessionWallet]);

    const endGame = useCallback(async (): Promise<string> => {
        if (!erProgram) throw new Error("ER Program not loaded");
        return performErAction("endGame", "end game");
    }, [erProgram, performErAction]);

    const resetGame = useCallback(async (): Promise<string> => {
        if (!erProgram) throw new Error("ER Program not loaded");
        return performErAction("resetGame", "reset game");
    }, [erProgram, performErAction]);

    // ========================================
    // Ephemeral Rollup Management
    // ========================================

    const delegate = useCallback(async (): Promise<string> => {
        if (!program || !wallet.publicKey) {
            throw new Error("Wallet not connected");
        }

        setIsLoading(true);
        setIsDelegating(true);
        setError(null);

        try {
            // Devnet doesn't need validator identity in remaining accounts

            // Delegate to a specific public ER validator (required when multiple validators exist)
            const validator = erValidatorIdentity ?? DEFAULT_ER_VALIDATOR.identity;
            const tx = await program.methods
                .delegate()
                .accounts({
                    payer: wallet.publicKey,
                })
                .remainingAccounts([
                    {
                        pubkey: validator,
                        isSigner: false,
                        isWritable: false,
                    },
                ])
                .rpc({
                    skipPreflight: true,
                });

            // Wait for delegation to propagate
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

    // Get the current active game state (ER if delegated, base layer otherwise)
    const currentGameState = useMemo(() => {
        if (delegationStatus === "delegated" && erGameAccount) {
            return erGameAccount;
        }
        return gameAccount;
    }, [delegationStatus, erGameAccount, gameAccount]);

    // Derived: is account properly initialized (exists on base layer or ER with data)
    const isInitialized = useMemo(() => {
        if (isCheckingAccount) return undefined; // Still checking
        return gameAccount !== null || (delegationStatus === "delegated" && erGameAccount !== null);
    }, [isCheckingAccount, gameAccount, delegationStatus, erGameAccount]);

    return {
        // State
        program,
        gameAccount,
        erGameAccount,
        currentGameState,
        gamePubkey,
        isLoading,
        isDelegating,
        isCheckingAccount,
        isInitialized,
        error,
        delegationStatus,
        txCount,
        lastTxTime,

        // Base layer operations
        initialize,

        // Game actions (run on ER when delegated)
        startGame,
        flap,
        tick,
        endGame,
        resetGame,

        // ER management
        delegate,
        commit,
        undelegate,

        // Session management
        createSession,
        sessionToken,
        isSessionLoading,

        // Utilities
        refetch: fetchGameAccount,
        checkDelegation: checkDelegationStatus,
    };
}
