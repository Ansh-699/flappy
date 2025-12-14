import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider, BN, setProvider } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { type FlappyBird } from "../idl/flappy_bird";
import IDL from "../idl/flappy_bird.json";
import { useSessionKeyManager } from "@magicblock-labs/gum-react-sdk";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Note: @magicblock-labs/ephemeral-rollups-sdk is imported dynamically to avoid
// Buffer not defined errors during module initialization

// ========================================
// NETWORK CONFIGURATION - Toggle between localnet and devnet
// ========================================
const USE_LOCALNET = false; // Devnet

// Localnet configuration (MagicBlock ER validator)
// Use 127.0.0.1 instead of localhost for better Firefox CORS support
const LOCAL_ER_ENDPOINT = "http://127.0.0.1:7799";
const LOCAL_ER_WS_ENDPOINT = "ws://127.0.0.1:7800";
const LOCAL_ER_VALIDATOR = new PublicKey("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");

// Devnet configuration
const DEVNET_ER_ENDPOINT = "https://devnet-as.magicblock.app";
const DEVNET_ER_WS_ENDPOINT = "wss://devnet-as.magicblock.app";
const DEVNET_ER_VALIDATOR = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
const DEVNET_ER_GENERIC_ENDPOINT = "https://devnet.magicblock.app";
const DEVNET_ER_GENERIC_WS_ENDPOINT = "wss://devnet.magicblock.app";

// Select based on network
const ER_VALIDATOR_IDENTITY = USE_LOCALNET ? LOCAL_ER_VALIDATOR : DEVNET_ER_VALIDATOR;
const ER_ENDPOINT = USE_LOCALNET ? LOCAL_ER_ENDPOINT : DEVNET_ER_ENDPOINT;
const ER_WS_ENDPOINT = USE_LOCALNET ? LOCAL_ER_WS_ENDPOINT : DEVNET_ER_WS_ENDPOINT;
const ER_GENERIC_ENDPOINT = USE_LOCALNET ? LOCAL_ER_ENDPOINT : DEVNET_ER_GENERIC_ENDPOINT;
const ER_GENERIC_WS_ENDPOINT = USE_LOCALNET ? LOCAL_ER_WS_ENDPOINT : DEVNET_ER_GENERIC_WS_ENDPOINT;

// Pipe data structure (matches on-chain Pipe struct)
interface Pipe {
    x: number;
    gapY: number;
    passed: boolean;
    active: boolean;
}

// Game status enum mapping
type GameStatusEnum = { notStarted: {} } | { playing: {} } | { gameOver: {} };

// Helper to convert enum to number
function getGameStatusNumber(status: GameStatusEnum): number {
    if ("notStarted" in status) return 0;
    if ("playing" in status) return 1;
    if ("gameOver" in status) return 2;
    return 0;
}

// Game account data structure
interface GameAccount {
    score: bigint;
    highScore: bigint;
    gameStatus: number; // 0 = NotStarted, 1 = Playing, 2 = GameOver
    birdY: number;      // Fixed-point scaled by 1000
    birdVelocity: number; // Fixed-point scaled by 1000
    frameCount: bigint;
    pipes: Pipe[];
    authority: PublicKey;
}

// Delegation status
export type DelegationStatus = "undelegated" | "delegated" | "checking";

/**
 * Hook to interact with the Flappy Bird game program on Solana.
 * Provides real-time updates via WebSocket subscriptions.
 * Supports MagicBlock Ephemeral Rollups for delegation, commit, and undelegation.
 * 
 * Network: ${USE_LOCALNET ? "LOCALNET" : "DEVNET"}
 */
export function useFlappyBirdProgram() {
    const { connection } = useConnection();
    const wallet = useWallet();

    const [gamePubkey, setGamePubkeyState] = useState<PublicKey | null>(() => {
        // Derive PDA from wallet public key if connected
        return null;
    });

    const [gameAccount, setGameAccount] = useState<GameAccount | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isDelegating, setIsDelegating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [delegationStatus, setDelegationStatus] = useState<DelegationStatus>("checking");
    // ER game state - full state for on-chain rendering
    const [erGameValue, setErGameValue] = useState<{
        score: bigint;
        high_score: bigint;
        birdY: number;
        birdVelocity: number;
        gameStatus: number;
        pipes: Pipe[];
    } | null>(null);

    // Devnet safety: avoid sending overlapping tick transactions (same writable account)
    const tickInFlightRef = useRef(false);
    const lastTickAttemptMsRef = useRef(0);

    // Session key funding cache (so we don't check/fund on every tick)
    const sessionFeePayerFundedRef = useRef<Set<string>>(new Set());
    const sessionFeePayerLastCheckMsRef = useRef<Map<string, number>>(new Map());

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

    // Ephemeral Rollup connection and provider
    const erConnection = useMemo(() => {
        return new Connection(ER_ENDPOINT, {
            wsEndpoint: ER_WS_ENDPOINT,
            commitment: "confirmed",
        });
    }, []);

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

    // Session Key Manager - always use devnet where Gum SDK programs are deployed
    // gum-react-sdk can crash when wallet.publicKey is null on first render.
    // Use a stable dummy keypair that won't change between renders
    const [dummyKeypair] = useState(() => Keypair.generate());
    
    // Only initialize session wallet when we have a real wallet connection
    const sessionWallet = useSessionKeyManager(
        wallet.publicKey ? wallet : {
            ...wallet,
            publicKey: dummyKeypair.publicKey,
        } as any,
        connection,
        "devnet"
    );

    const { sessionToken, createSession: sdkCreateSession, isLoading: isSessionLoading } = sessionWallet;

    const createSession = useCallback(async () => {
        return await sdkCreateSession(new PublicKey(IDL.address));
    }, [sdkCreateSession]);

    // Derive PDA from wallet public key - using game_v2 seed to get fresh PDA
    const derivePDA = useCallback((authority: PublicKey) => {
        const GAME_SEED = Buffer.from("game_v2");
        const [pda] = PublicKey.findProgramAddressSync(
            [GAME_SEED, authority.toBuffer()],
            new PublicKey(IDL.address)
        );
        console.log("[PDA] Derived with game_v2 seed:", pda.toString());
        return pda;
    }, []);

    // Auto-derive game PDA when wallet connects
    useEffect(() => {
        if (wallet.publicKey) {
            const pda = derivePDA(wallet.publicKey);
            console.log("[PDA] Setting game pubkey to:", pda.toString());
            setGamePubkeyState(pda);
        } else {
            setGamePubkeyState(null);
        }
    }, [wallet.publicKey, derivePDA]);

    // Fetch game account data from base layer
    const fetchGameAccount = useCallback(async () => {
        if (!program || !gamePubkey) {
            setGameAccount(null);
            return;
        }

        try {
            const account = await program.account.gameState.fetch(gamePubkey);
            // Parse pipes array
            const pipes = (account.pipes || []).map((p: any) => ({
                x: p.x,
                gapY: p.gapY,
                passed: p.passed,
                active: p.active,
            }));
            
            setGameAccount({
                score: BigInt(account.score.toString()),
                highScore: BigInt(account.highScore.toString()),
                gameStatus: getGameStatusNumber(account.gameStatus as unknown as GameStatusEnum),
                birdY: account.birdY,
                birdVelocity: account.birdVelocity,
                frameCount: BigInt(account.frameCount?.toString() || "0"),
                pipes,
                authority: account.authority,
            });
            setError(null);
        } catch (err) {
            // This is expected when the game hasn't been initialized yet
            console.debug("Game account not found (this is normal for new wallets):", err);
            setGameAccount(null);
            // Only set error for unexpected errors, not "account does not exist"
            if (err instanceof Error && !err.message.includes("Account does not exist") && !err.message.includes("could not find account")) {
                setError(err.message);
            }
        }
    }, [program, gamePubkey]);

    // Delegation Program address - when an account is delegated, its owner changes to this
    const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

    // Check if account is delegated by checking the account owner on base layer
    const checkDelegationStatus = useCallback(async () => {
        if (!gamePubkey) {
            setDelegationStatus("checking");
            return;
        }

        try {
            setDelegationStatus("checking");

            // Get account info from base layer to check the owner
            const accountInfo = await connection.getAccountInfo(gamePubkey);

            if (!accountInfo) {
                // Account doesn't exist yet
                setDelegationStatus("undelegated");
                setErGameValue(null);
                return;
            }

            // Check if the account owner is the delegation program
            const isDelegated = accountInfo.owner.equals(DELEGATION_PROGRAM_ID);

            if (isDelegated) {
                setDelegationStatus("delegated");
                // Try to fetch the game value from ER
                if (erProgram) {
                    try {
                        const account = await erProgram.account.gameState.fetch(gamePubkey);
                        const pipes = (account.pipes || []).map((p: any) => ({
                            x: p.x,
                            gapY: p.gapY,
                            passed: p.passed,
                            active: p.active,
                        }));
                        setErGameValue({
                            score: BigInt(account.score.toString()),
                            high_score: BigInt(account.highScore.toString()),
                            birdY: account.birdY,
                            birdVelocity: account.birdVelocity,
                            gameStatus: getGameStatusNumber(account.gameStatus as unknown as GameStatusEnum),
                            pipes,
                        });
                    } catch {
                        // Couldn't fetch from ER, but it's still delegated
                        console.debug("Couldn't fetch game from ER");
                    }
                }
            } else {
                setDelegationStatus("undelegated");
                setErGameValue(null);
            }
        } catch (err) {
            console.debug("Error checking delegation status:", err);
            setDelegationStatus("undelegated");
            setErGameValue(null);
        }
    }, [gamePubkey, connection, erProgram]);

    // Subscribe to base layer account changes via WebSocket
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
                    const decoded = program.coder.accounts.decode("gameState", accountInfo.data);
                    const pipes = (decoded.pipes || []).map((p: any) => ({
                        x: p.x,
                        gapY: p.gapY,
                        passed: p.passed,
                        active: p.active,
                    }));
                    setGameAccount({
                        score: BigInt(decoded.score.toString()),
                        highScore: BigInt(decoded.highScore.toString()),
                        gameStatus: getGameStatusNumber(decoded.gameStatus as unknown as GameStatusEnum),
                        birdY: decoded.birdY,
                        birdVelocity: decoded.birdVelocity,
                        frameCount: BigInt(decoded.frameCount?.toString() || "0"),
                        pipes,
                        authority: decoded.authority,
                    });
                    setError(null);
                    // Recheck delegation status when base layer changes
                    checkDelegationStatus();
                } catch (err) {
                    console.error("Failed to decode account data:", err);
                }
            },
            "confirmed"
        );

        return () => {
            connection.removeAccountChangeListener(subscriptionId);
        };
    }, [program, gamePubkey, connection, fetchGameAccount, checkDelegationStatus]);

    // Subscribe to ER account changes when delegated
    useEffect(() => {
        if (!erProgram || !gamePubkey || delegationStatus !== "delegated") {
            return;
        }

        // Initial fetch from ER to get current state
        const fetchErState = async () => {
            try {
                const account = await erProgram.account.gameState.fetch(gamePubkey);
                const pipes = (account.pipes || []).map((p: any) => ({
                    x: p.x,
                    gapY: p.gapY,
                    passed: p.passed,
                    active: p.active,
                }));
                setErGameValue({
                    score: BigInt(account.score.toString()),
                    high_score: BigInt(account.highScore.toString()),
                    birdY: account.birdY,
                    birdVelocity: account.birdVelocity,
                    gameStatus: getGameStatusNumber(account.gameStatus as unknown as GameStatusEnum),
                    pipes,
                });
                console.log("[ER] Initial state fetched:", {
                    score: account.score.toString(),
                    birdY: account.birdY / 1000,
                    status: account.gameStatus,
                });
            } catch (err) {
                console.debug("[ER] Initial fetch failed:", err);
            }
        };
        
        fetchErState();

        const subscriptionId = erConnection.onAccountChange(
            gamePubkey,
            async (accountInfo) => {
                try {
                    const decoded = erProgram.coder.accounts.decode("gameState", accountInfo.data);
                    const pipes = (decoded.pipes || []).map((p: any) => ({
                        x: p.x,
                        gapY: p.gapY,
                        passed: p.passed,
                        active: p.active,
                    }));
                    setErGameValue({
                        score: BigInt(decoded.score.toString()),
                        high_score: BigInt(decoded.highScore.toString()),
                        birdY: decoded.birdY,
                        birdVelocity: decoded.birdVelocity,
                        gameStatus: getGameStatusNumber(decoded.gameStatus as unknown as GameStatusEnum),
                        pipes,
                    });
                } catch (err) {
                    console.error("[ER] Failed to decode account data:", err);
                }
            },
            "confirmed"
        );

        console.log("[ER] WebSocket subscription active for:", gamePubkey.toBase58());

        return () => {
            console.log("[ER] Cleaning up WebSocket subscription");
            erConnection.removeAccountChangeListener(subscriptionId);
        };
    }, [erProgram, gamePubkey, erConnection, delegationStatus]);

    // Initialize a new game (uses PDA derived from wallet)
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

            // PDA is already set from wallet connection
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

    // Start game (on base layer)
    const startGame = useCallback(async (): Promise<string> => {
        if (!program || !wallet.publicKey || !gamePubkey) {
            throw new Error("Game not initialized");
        }

        setIsLoading(true);
        setError(null);

        try {
            const tx = await program.methods
                .startGame()
                .accounts({
                    game: gamePubkey,
                    signer: wallet.publicKey,
                    sessionToken: null,
                } as any)
                .rpc();

            return tx;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to start game";
            setError(message);
            throw err;
        } finally {
            setIsLoading(false);
        }
    }, [program, wallet.publicKey, gamePubkey]);

    // End game (on base layer)
    const endGame = useCallback(async (): Promise<string> => {
        if (!program || !wallet.publicKey || !gamePubkey) {
            throw new Error("Game not initialized");
        }

        setIsLoading(true);
        setError(null);

        try {
            const tx = await program.methods
                .endGame()
                .accounts({
                    game: gamePubkey,
                    signer: wallet.publicKey,
                    sessionToken: null,
                } as any)
                .rpc();

            return tx;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to end game";
            setError(message);
            throw err;
        } finally {
            setIsLoading(false);
        }
    }, [program, wallet.publicKey, gamePubkey]);

    // Reset game (on base layer)
    const resetGame = useCallback(async (): Promise<string> => {
        if (!program || !wallet.publicKey || !gamePubkey) {
            throw new Error("Game not initialized");
        }

        setIsLoading(true);
        setError(null);

        try {
            const tx = await program.methods
                .resetGame()
                .accounts({
                    game: gamePubkey,
                    signer: wallet.publicKey,
                    sessionToken: null,
                } as any)
                .rpc();

            return tx;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to reset game";
            setError(message);
            throw err;
        } finally {
            setIsLoading(false);
        }
    }, [program, wallet.publicKey, gamePubkey]);

    const performErAction = useCallback(async (
        methodBuilder: any,
        actionName: string
    ): Promise<string> => {
        if (!program || !wallet.publicKey || !wallet.signTransaction || !gamePubkey) {
            throw new Error("Game not initialized or not delegated");
        }

        // Tick is called on an interval; on devnet we must avoid overlap and excessive TPS.
        if (actionName === "tick") {
            if (tickInFlightRef.current) {
                return "";
            }
            if (!USE_LOCALNET) {
                const now = Date.now();
                if (now - lastTickAttemptMsRef.current < 150) {
                    return "";
                }
                lastTickAttemptMsRef.current = now;
            }
            tickInFlightRef.current = true;
        }

        setIsLoading(true);
        setError(null);

        let builtTx: Transaction | null = null;
        let conn: Connection | null = null;
        let latestBlockhash: Awaited<ReturnType<Connection["getLatestBlockhash"]>> | null = null;

        const ensureSessionFeePayerFunded = async (c: Connection, sessionFeePayer: PublicKey) => {
            const key = sessionFeePayer.toBase58();

            if (sessionFeePayerFundedRef.current.has(key)) return;

            const now = Date.now();
            const last = sessionFeePayerLastCheckMsRef.current.get(key) ?? 0;
            if (now - last < 15_000) return;
            sessionFeePayerLastCheckMsRef.current.set(key, now);

            // Only the wallet can fund the session key (one-time prompt).
            if (!wallet.publicKey || !wallet.signTransaction) return;

            const balance = await c.getBalance(sessionFeePayer, "confirmed");
            const minLamports = 200_000; // 0.0002 SOL
            if (balance >= minLamports) {
                sessionFeePayerFundedRef.current.add(key);
                return;
            }

            const topUpLamports = 2_000_000; // 0.002 SOL
            const fundTx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: wallet.publicKey,
                    toPubkey: sessionFeePayer,
                    lamports: topUpLamports,
                })
            );
            fundTx.feePayer = wallet.publicKey;
            const bh = await c.getLatestBlockhash();
            fundTx.recentBlockhash = bh.blockhash;
            const signed = (await wallet.signTransaction(fundTx)) as Transaction;
            const sig = await c.sendRawTransaction(signed.serialize(), {
                skipPreflight: false,
                maxRetries: 3,
            });
            await c.confirmTransaction(
                { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
                "confirmed"
            );
            sessionFeePayerFundedRef.current.add(key);
            console.log(`[ER session] funded session key ${key} with ${topUpLamports / LAMPORTS_PER_SOL} SOL: ${sig}`);
        };

        try {
            // IMPORTANT: must send writes to the same ER validator that holds the delegation.
            // The generic router can land on a different validator/region and will reject writes
            // with InvalidWritableAccount.
            conn = new Connection(ER_ENDPOINT, {
                wsEndpoint: ER_WS_ENDPOINT,
                commitment: "confirmed",
            });

            const hasSession = sessionToken != null && sessionWallet != null;
            const hasSessionSigner = hasSession && typeof (sessionWallet as any)?.signTransaction === "function";
            const sessionFeePayer: PublicKey | null = hasSessionSigner ? (sessionWallet as any).publicKey : null;
            const signer: PublicKey = hasSession ? (sessionWallet as any).publicKey : wallet.publicKey;

            const accounts: any = {
                game: gamePubkey,
                signer,
                sessionToken: hasSession ? sessionToken : null,
            };

            builtTx = await methodBuilder.accounts(accounts).transaction();
            if (!builtTx) {
                throw new Error("Failed to build transaction");
            }

            if (sessionFeePayer) {
                await ensureSessionFeePayerFunded(conn, sessionFeePayer);
            }

            const feePayer: PublicKey = sessionFeePayer ?? wallet.publicKey;
            builtTx.feePayer = feePayer;

            latestBlockhash = await conn.getLatestBlockhash();
            builtTx.recentBlockhash = latestBlockhash.blockhash;

            if (hasSessionSigner) {
                builtTx = await (sessionWallet as any).signTransaction(builtTx);
            }
            if (!sessionFeePayer) {
                builtTx = (await wallet.signTransaction(builtTx!)) as Transaction;
            }

            const txHash = await conn.sendRawTransaction(builtTx!.serialize(), {
                skipPreflight: actionName !== "tick",
                maxRetries: 3,
            });
            await conn.confirmTransaction(
                {
                    signature: txHash,
                    blockhash: latestBlockhash.blockhash,
                    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
                },
                "confirmed"
            );

            if (erProgram) {
                try {
                    const account = await erProgram.account.gameState.fetch(gamePubkey);
                    const pipes = (account.pipes || []).map((p: any) => ({
                        x: p.x,
                        gapY: p.gapY,
                        passed: p.passed,
                        active: p.active,
                    }));
                    setErGameValue({
                        score: BigInt(account.score.toString()),
                        high_score: BigInt(account.highScore.toString()),
                        birdY: account.birdY,
                        birdVelocity: account.birdVelocity,
                        gameStatus: getGameStatusNumber(account.gameStatus as unknown as GameStatusEnum),
                        pipes,
                    });
                } catch {
                    // Ignore fetch errors
                }
            }

            return txHash;
        } catch (err) {
            const anyErr = err as any;
            const signature: string | null =
                (typeof anyErr?.signature === "string" && anyErr.signature.length > 0) ? anyErr.signature :
                (typeof anyErr?.txid === "string" && anyErr.txid.length > 0) ? anyErr.txid :
                null;

            console.error(`[ER ${actionName}] failed:`, err);
            if (signature) {
                console.error(`[ER ${actionName}] signature:`, signature);
            }

            try {
                if (Array.isArray(anyErr?.logs)) {
                    console.error(`[ER ${actionName}] logs (from error):`, anyErr.logs);
                }

                if (signature && conn) {
                    for (let i = 0; i < 3; i++) {
                        const tx = await conn.getTransaction(signature, {
                            commitment: "confirmed",
                            maxSupportedTransactionVersion: 0,
                        });
                        const logs = tx?.meta?.logMessages;
                        if (logs && logs.length) {
                            console.error(`[ER ${actionName}] logs (confirmed):`, logs);
                            break;
                        }
                        await sleep(400);
                    }
                } else if (conn && builtTx) {
                    try {
                        const sim = await conn.simulateTransaction(builtTx);
                        console.error(`[ER ${actionName}] simulate err:`, sim.value.err);
                        console.error(`[ER ${actionName}] simulate logs:`, sim.value.logs);
                    } catch (simErr) {
                        console.error(`[ER ${actionName}] simulate failed:`, simErr);
                    }
                }
            } catch (logErr) {
                console.error(`[ER ${actionName}] failed to fetch logs:`, logErr);
            }

            const message = err instanceof Error ? err.message : `Failed to ${actionName} on ER`;
            setError(message);
            throw err;
        } finally {
            setIsLoading(false);
            if (actionName === "tick") {
                tickInFlightRef.current = false;
            }
        }
    }, [program, wallet.publicKey, wallet.signTransaction, gamePubkey, sessionToken, sessionWallet, erProgram]);

    // Start game on Ephemeral Rollup
    const startGameOnER = useCallback(async (): Promise<string> => {
        if (!program) throw new Error("Program not loaded");
        return performErAction(program.methods.startGame(), "start game");
    }, [program, performErAction]);

    // End game on Ephemeral Rollup
    const endGameOnER = useCallback(async (): Promise<string> => {
        if (!program) throw new Error("Program not loaded");
        return performErAction(program.methods.endGame(), "end game");
    }, [program, performErAction]);

    // Reset game on Ephemeral Rollup
    const resetGameOnER = useCallback(async (): Promise<string> => {
        if (!program) throw new Error("Program not loaded");
        return performErAction(program.methods.resetGame(), "reset game");
    }, [program, performErAction]);

    // Flap (jump) on Ephemeral Rollup - main game input
    const flapOnER = useCallback(async (): Promise<string> => {
        if (!program) throw new Error("Program not loaded");
        return performErAction(program.methods.flap(), "flap");
    }, [program, performErAction]);

    // Tick (physics update) on Ephemeral Rollup
    const tickOnER = useCallback(async (): Promise<string> => {
        if (!program) throw new Error("Program not loaded");
        return performErAction(program.methods.tick(), "tick");
    }, [program, performErAction]);

    // ========================================
    // Ephemeral Rollups Functions
    // ========================================

    // Delegate the game to Ephemeral Rollups
    const delegate = useCallback(async (): Promise<string> => {
        if (!program || !wallet.publicKey) {
            throw new Error("Wallet not connected");
        }

        setIsLoading(true);
        setIsDelegating(true);
        setError(null);

        try {
            // Build the delegate instruction for devnet
            // IMPORTANT: Must pass the validator identity in remainingAccounts
            const tx = await program.methods
                .delegate()
                .accounts({
                    payer: wallet.publicKey,
                })
                .remainingAccounts([
                    {
                        pubkey: ER_VALIDATOR_IDENTITY,
                        isSigner: false,
                        isWritable: false,
                    },
                ])
                .rpc({
                skipPreflight: true,
            });

            // Wait a bit for delegation to propagate
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Recheck delegation status
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
    }, [program, wallet.publicKey, checkDelegationStatus]);

    // Commit state from ER to base layer (runs on ER)
    const commit = useCallback(async (): Promise<string> => {
        if (!program || !wallet.publicKey || !wallet.signTransaction || !gamePubkey) {
            throw new Error("Game not initialized or not delegated");
        }

        setIsLoading(true);
        setError(null);

        try {
            // Must hit the same ER validator that holds the delegation.
            const genericErConnection = new Connection(ER_ENDPOINT, {
                wsEndpoint: ER_WS_ENDPOINT,
                commitment: "confirmed",
            });

            // Build transaction using base program
            let tx = await program.methods
                .commit()
                .accounts({
                    payer: wallet.publicKey,
                })
                .transaction();

            // Set up for ER connection
            tx.feePayer = wallet.publicKey;
            tx.recentBlockhash = (await genericErConnection.getLatestBlockhash()).blockhash;
            tx = await wallet.signTransaction(tx);

            // Send using raw connection
            const txHash = await genericErConnection.sendRawTransaction(tx.serialize(), {
                skipPreflight: true,
            });
            await genericErConnection.confirmTransaction(txHash, "confirmed");

            console.log("Commit successful:", txHash);

            // Refresh base layer game value
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

    // Undelegate the game from ER (runs on ER)
    const undelegate = useCallback(async (): Promise<string> => {
        if (!program || !wallet.publicKey || !wallet.signTransaction || !gamePubkey) {
            throw new Error("Game not initialized or not delegated");
        }

        setIsLoading(true);
        setError(null);

        try {
            // Must hit the same ER validator that holds the delegation.
            const genericErConnection = new Connection(ER_ENDPOINT, {
                wsEndpoint: ER_WS_ENDPOINT,
                commitment: "confirmed",
            });

            // Build transaction using base program
            let tx = await program.methods
                .undelegate()
                .accounts({
                    payer: wallet.publicKey,
                })
                .transaction();

            // Set up for ER connection
            tx.feePayer = wallet.publicKey;
            tx.recentBlockhash = (await genericErConnection.getLatestBlockhash()).blockhash;
            tx = await wallet.signTransaction(tx);

            // Send using raw connection
            const txHash = await genericErConnection.sendRawTransaction(tx.serialize(), {
                skipPreflight: true,
            });
            await genericErConnection.confirmTransaction(txHash, "confirmed");

            console.log("Undelegate successful:", txHash);

            // Wait for undelegation to propagate to base layer
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Update state
            setDelegationStatus("undelegated");
            setErGameValue(null);

            // Refresh base layer game value
            await fetchGameAccount();
            await checkDelegationStatus();

            return txHash;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to undelegate game";
            setError(message);
            throw err;
        } finally {
            setIsLoading(false);
        }
    }, [program, wallet.publicKey, wallet.signTransaction, gamePubkey, fetchGameAccount, checkDelegationStatus]);

    // Airdrop SOL to wallet (localnet only)
    const airdrop = useCallback(async (amount: number = 2): Promise<string> => {
        if (!wallet.publicKey) {
            throw new Error("Wallet not connected");
        }

        if (!USE_LOCALNET) {
            throw new Error("Airdrop only available on localnet. Visit a faucet for devnet SOL.");
        }

        try {
            setIsLoading(true);
            console.log(`[Airdrop] Requesting ${amount} SOL for ${wallet.publicKey.toString()}`);
            
            const signature = await connection.requestAirdrop(
                wallet.publicKey,
                amount * 1_000_000_000 // Convert to lamports
            );
            
            await connection.confirmTransaction(signature, "confirmed");
            console.log("[Airdrop] Success:", signature);
            return signature;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to airdrop";
            setError(message);
            throw err;
        } finally {
            setIsLoading(false);
        }
    }, [connection, wallet.publicKey]);

    // Check wallet SOL balance
    const getBalance = useCallback(async (): Promise<number> => {
        if (!wallet.publicKey) {
            return 0;
        }
        const balance = await connection.getBalance(wallet.publicKey);
        return balance / 1_000_000_000; // Convert to SOL
    }, [connection, wallet.publicKey]);

    return {
        program,
        gameAccount,
        gamePubkey,
        isLoading,
        isDelegating,
        error,
        // Base layer operations
        initialize,
        startGame,
        endGame,
        resetGame,
        // Ephemeral Rollups operations
        delegate,
        commit,
        undelegate,
        startGameOnER,
        endGameOnER,
        resetGameOnER,
        flapOnER,
        tickOnER,
        // Delegation status
        delegationStatus,
        erGameValue,
        // Utilities
        refetch: fetchGameAccount,
        checkDelegation: checkDelegationStatus,
        airdrop,
        getBalance,
        isLocalnet: USE_LOCALNET,
        // Session
        createSession,
        sessionToken,
        isSessionLoading,
    };
}

