import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider, BN, setProvider } from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { type FlappyBird } from "../idl/flappy_bird";
import IDL from "../idl/flappy_bird.json";
import { useSessionKeyManager } from "@magicblock-labs/gum-react-sdk";

// Note: @magicblock-labs/ephemeral-rollups-sdk is imported dynamically to avoid
// Buffer not defined errors during module initialization

// ========================================
// NETWORK CONFIGURATION - Toggle between localnet and devnet
// ========================================
const USE_LOCALNET = false; // Set to false for devnet (session keys work here)

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
        console.log("[useFlappyBirdProgram] Creating erProvider. Wallet state:", {
            connected: wallet.connected,
            hasPublicKey: !!wallet.publicKey,
            hasSignTransaction: !!wallet.signTransaction,
            hasSignAllTransactions: !!wallet.signAllTransactions
        });

        if (!wallet.publicKey) {
            console.warn("[useFlappyBirdProgram] erProvider creation skipped: No public key");
            return null;
        }

        // Create a compliant wallet object even if capabilities are missing
        // This allows erProgram to be created for read-only operations (fetching functionality)
        const diffWallet = {
            publicKey: wallet.publicKey,
            signTransaction: wallet.signTransaction || (async (tx: any) => {
                throw new Error("signTransaction not implemented in dummy wallet");
            }),
            signAllTransactions: wallet.signAllTransactions || (async (txs: any[]) => {
                throw new Error("signAllTransactions not implemented in dummy wallet");
            })
        };

        return new AnchorProvider(
            erConnection,
            diffWallet,
            { commitment: "confirmed" }
        );
    }, [erConnection, wallet.publicKey, wallet.signTransaction, wallet.signAllTransactions]);

    const erProgram = useMemo(() => {
        if (!erProvider) {
            return null;
        }

        return new Program<FlappyBird>(IDL as FlappyBird, erProvider);
    }, [erProvider]);

    // Session Key Manager - only available on devnet where Gum SDK programs are deployed
    // On localnet, session keys are disabled since the Gum programs don't exist

    // Memoize the wallet adapter object to prevent useSessionKeyManager from triggering re-renders
    const walletAdapter = useMemo(() => ({
        ...wallet,
        publicKey: wallet.publicKey ?? new PublicKey("11111111111111111111111111111111"),
    }), [wallet.publicKey, wallet.signTransaction, wallet.signAllTransactions, wallet.connected]);

    const sessionWallet = USE_LOCALNET ? null : useSessionKeyManager(
        walletAdapter as any,
        connection,
        "devnet"
    );

    // On localnet, session keys are disabled
    const sessionToken = USE_LOCALNET ? null : sessionWallet?.sessionToken ?? null;
    const isSessionLoading = USE_LOCALNET ? false : sessionWallet?.isLoading ?? false;

    const createSession = useCallback(async () => {
        if (USE_LOCALNET) {
            throw new Error("Session keys are only available on devnet. On localnet, each transaction requires wallet approval.");
        }
        if (!sessionWallet) {
            throw new Error("Session wallet not initialized");
        }
        return await sessionWallet.createSession(new PublicKey(IDL.address));
    }, [sessionWallet]);

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
                    console.error("Failed to decode ER account data:", err);
                }
            },
            "confirmed"
        );

        return () => {
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

    // Refs for stable access inside callbacks to prevent re-creation of performErAction
    const contextRef = useRef({
        program,
        wallet,
        gamePubkey,
        sessionToken,
        sessionWallet,
        erProgram,
        connection
    });

    useEffect(() => {
        contextRef.current = {
            program,
            wallet,
            gamePubkey,
            sessionToken,
            sessionWallet,
            erProgram,
            connection
        };
    });

    const performErAction = useCallback(async (
        methodBuilder: any,
        actionName: string,
        confirm: boolean = true // New parameter, default is true
    ): Promise<string> => {
        const { program, wallet, gamePubkey, sessionToken, sessionWallet, erProgram } = contextRef.current;

        if (!program || !wallet.publicKey || !wallet.signTransaction || !gamePubkey) {
            throw new Error("Game not initialized or not delegated");
        }

        setIsLoading(true);
        setError(null);

        try {
            // Use the specific validator endpoint where we delegated the account
            // Do NOT use the generic endpoint - it may route to a different validator that doesn't have our account
            const validatorErConnection = new Connection(ER_ENDPOINT, {
                wsEndpoint: ER_WS_ENDPOINT,
                commitment: "confirmed",
            });

            // Check usage of erProgram
            if (!erProgram) {
                console.warn("[performErAction] erProgram is null! Cannot fetch state.");
            } else {
                console.log("[performErAction] erProgram is available.");
            }

            // Check if we have a valid session
            const hasSession = sessionToken != null && sessionWallet != null;
            const signer = hasSession ? sessionWallet.publicKey : wallet.publicKey;

            console.log(`[ER Action: ${actionName}]`);
            console.log(`  Has Session: ${hasSession}`);
            console.log(`  Signer: ${signer?.toString()}`);
            console.log(`  Session Token: ${sessionToken ? (typeof sessionToken === 'object' ? JSON.stringify(sessionToken) : sessionToken.toString()) : 'null'}`);
            console.log(`  Game PDA: ${gamePubkey.toString()}`);
            console.log(`  ER Endpoint: ${ER_ENDPOINT}`);

            // Build accounts
            const accounts: any = {
                game: gamePubkey,
                signer: signer,
                sessionToken: hasSession ? sessionToken : null,
            };

            // Build transaction
            let tx = await methodBuilder
                .accounts(accounts)
                .transaction();
            tx.feePayer = signer;
            tx.recentBlockhash = (await validatorErConnection.getLatestBlockhash()).blockhash;

            // Sign
            if (hasSession && sessionWallet) {
                if (typeof sessionWallet.signTransaction === 'function') {
                    // It's a Wallet Adapter-like object
                    tx.feePayer = sessionWallet.publicKey;
                    // Note: sessionWallet.signTransaction returns the signed tx
                    // We must assign it back if it returns a new object, or it modifies in place?
                    // Standard wallet adapter returns Promise<Transaction>
                    const signedTx = await sessionWallet.signTransaction(tx);
                    // If it returns a new object, we must use it. 
                    // But we declared 'let tx' so we can assign it.
                    // Wait, methodBuilder.transaction() returns 'Transaction'.
                    // Typescript might complain if types mismatch.
                    // Let's assume it works as before.
                    // The previous code had: tx = await sessionWallet.signTransaction(tx);
                    // So let's convert 'let tx' back to that usage.
                    const potentiallyNewTx = await sessionWallet.signTransaction(tx);
                    if (potentiallyNewTx) {
                        tx = potentiallyNewTx;
                    }
                } else {
                    // It's likely a Keypair
                    tx.sign(sessionWallet);
                }
            } else {
                await wallet.signTransaction(tx);
            }

            // Send
            const txHash = await validatorErConnection.sendRawTransaction(tx.serialize(), {
                skipPreflight: true,
            });

            if (confirm) {
                await validatorErConnection.confirmTransaction(txHash, "confirmed");
            } else {
                if (actionName !== "tick") console.log(`[ER Action: ${actionName}] Sent (Fire & Forget): ${txHash}`);
            }

            // Refresh ER game value
            if (erProgram) {
                try {
                    // console.log("[performErAction] Fetching updated game state from ER...");
                    const account = await erProgram.account.gameState.fetch(gamePubkey);
                    // console.log("[performErAction] Fetched account raw:", account);

                    const pipes = (account.pipes || []).map((p: any) => ({
                        x: p.x,
                        gapY: p.gapY,
                        passed: p.passed,
                        active: p.active,
                    }));

                    const newState = {
                        score: BigInt(account.score.toString()),
                        high_score: BigInt(account.highScore.toString()),
                        birdY: account.birdY,
                        birdVelocity: account.birdVelocity,
                        gameStatus: getGameStatusNumber(account.gameStatus as unknown as GameStatusEnum),
                        pipes,
                    };

                    // Serialize for readable logging (handle BigInt)
                    const logSafeState = JSON.parse(JSON.stringify(newState, (key, value) =>
                        typeof value === 'bigint' ? value.toString() : value
                    ));

                    if (actionName === "batch tick") {
                        // Less verbose for ticks
                        if (Math.random() < 0.05) console.log("[performErAction] New ER State:", logSafeState);
                    } else {
                        console.log("[performErAction] New ER State:", logSafeState);
                    }

                    setErGameValue(newState);
                } catch (fetchErr) {
                    console.error("[performErAction] Failed to fetch/parse ER state:", fetchErr);
                    // Ignore fetch errors
                }
            }

            return txHash;
        } catch (err) {
            const message = err instanceof Error ? err.message : `Failed to ${actionName} on ER`;
            setError(message);
            throw err;
        } finally {
            setIsLoading(false);
        }
    }, [erConnection]); // Added erConnection dependency

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
    const flapOnER = useCallback(async (confirm: boolean = true): Promise<string> => {
        if (!program) throw new Error("Program not loaded");
        return performErAction(program.methods.flap(), "flap", confirm);
    }, [program, performErAction]);

    // Tick (physics update) on Ephemeral Rollup
    const tickOnER = useCallback(async (confirm: boolean = true): Promise<string> => {
        if (!program) throw new Error("Program not loaded");
        return performErAction(program.methods.tick(), "tick", confirm);
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

            // Wait for delegation to propagate to ER
            // The ER validator needs time to clone the delegated account
            console.log("[Delegate] Waiting for ER to sync delegated account...");

            // Retry loop to verify account exists on ER
            let isErSynced = false;
            for (let attempt = 0; attempt < 10; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                try {
                    const erAccountInfo = await erConnection.getAccountInfo(gamePubkey!);
                    if (erAccountInfo) {
                        console.log(`[Delegate] ER synced after ${attempt + 1} seconds`);
                        isErSynced = true;
                        break;
                    }
                } catch (e) {
                    console.log(`[Delegate] ER sync attempt ${attempt + 1}/10...`);
                }
            }

            if (!isErSynced) {
                console.warn("[Delegate] Warning: Could not verify ER sync after 10s");
            }

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
    // Uses generic ER endpoint to route to the correct validator
    const commit = useCallback(async (): Promise<string> => {
        if (!program || !wallet.publicKey || !wallet.signTransaction || !gamePubkey) {
            throw new Error("Game not initialized or not delegated");
        }

        setIsLoading(true);
        setError(null);

        try {
            // Use generic endpoint for commit - it routes to the correct validator
            const genericErConnection = new Connection(ER_GENERIC_ENDPOINT, {
                wsEndpoint: ER_GENERIC_WS_ENDPOINT,
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
    // Uses the generic ER endpoint which routes to the correct validator internally
    const undelegate = useCallback(async (): Promise<string> => {
        if (!program || !wallet.publicKey || !wallet.signTransaction || !gamePubkey) {
            throw new Error("Game not initialized or not delegated");
        }

        setIsLoading(true);
        setError(null);

        try {
            // Use generic endpoint for undelegate - it routes to the correct validator
            const genericErConnection = new Connection(ER_GENERIC_ENDPOINT, {
                wsEndpoint: ER_GENERIC_WS_ENDPOINT,
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

    // Fetch Leaderboard (All accounts)
    const getLeaderboard = useCallback(async () => {
        if (!program) return [];
        try {
            // Fetch all game accounts from base layer
            // This incentivizes "Commit" to updates global leaderboard
            const allAccounts = await program.account.gameState.all();

            // Map and sort
            const sorted = allAccounts.map(acc => ({
                pubkey: acc.publicKey,
                highScore: Number(acc.account.highScore),
                authority: acc.account.authority
            }))
                .sort((a, b) => b.highScore - a.highScore)
                .slice(0, 5); // Top 5

            return sorted;

        } catch (e) {
            console.error("Failed to fetch leaderboard", e);
            return [];
        }
    }, [program]);

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
        getLeaderboard, // Exported
        isLocalnet: USE_LOCALNET,
        // Session
        createSession,
        sessionToken,
        isSessionLoading,
    };
}

