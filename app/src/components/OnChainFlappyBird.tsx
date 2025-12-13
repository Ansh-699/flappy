import { useState, useEffect, useRef, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
    useOnChainFlappyBird,
    GameStatus,
    GAME_WIDTH,
    GAME_HEIGHT,
    BIRD_SIZE,
    BIRD_X,
    PIPE_WIDTH,
    PIPE_GAP,
    type DelegationStatus,
} from "../hooks/use-onchain-flappy-bird";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

// Badge component for delegation status
function StatusBadge({ status }: { status: DelegationStatus }) {
    const styles: Record<DelegationStatus, { bg: string; text: string; label: string }> = {
        undelegated: { bg: "bg-gray-100", text: "text-gray-900", label: "Base Layer" },
        delegated: { bg: "bg-green-500", text: "text-white", label: "⚡ Ephemeral Rollup" },
        checking: { bg: "bg-gray-100", text: "text-gray-500", label: "Checking..." },
    };

    const style = styles[status];

    return (
        <span className={`px-2 py-1 rounded-full text-xs font-medium ${style.bg} ${style.text}`}>
            {style.label}
        </span>
    );
}

// Stats display component
function GameStats({ txCount, lastTxTime }: { txCount: number; lastTxTime: number | null }) {
    return (
        <div className="flex gap-4 text-sm text-gray-600">
            <div>
                <span className="font-medium">TX Count:</span> {txCount}
            </div>
            {lastTxTime && (
                <div>
                    <span className="font-medium">Last TX:</span> {lastTxTime}ms
                </div>
            )}
        </div>
    );
}

export function OnChainFlappyBird() {
    const { publicKey, connected } = useWallet();
    const {
        currentGameState,
        gameAccount,
        gamePubkey,
        isLoading,
        isDelegating,
        isCheckingAccount,
        isInitialized,
        error,
        delegationStatus,
        txCount,
        lastTxTime,
        // Operations
        initialize,
        startGame,
        flap,
        tick, // Enable tick for automatic game loop
        endGame,
        resetGame,
        delegate,
        commit,
        undelegate,
        createSession,
        sessionToken,
        isSessionLoading,
        checkDelegation,
    } = useOnChainFlappyBird();

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const gameLoopRef = useRef<number | null>(null);
    const flapRef = useRef(flap); // Store flap in a ref to avoid re-renders
    const isFlapPending = useRef(false); // Prevent duplicate flap transactions
    const [isStartingGame, setIsStartingGame] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false); // Local playing state for immediate UI feedback
    const [pendingTx, setPendingTx] = useState(false);
    
    // Keep flapRef updated
    useEffect(() => {
        flapRef.current = flap;
    }, [flap]);

    // Get display values from on-chain state
    const displayScore = currentGameState?.score ?? 0;
    const displayHighScore = currentGameState?.highScore ?? 0;
    const birdY = currentGameState ? currentGameState.birdY / 1000 : GAME_HEIGHT / 2;
    const pipes = currentGameState?.pipes ?? [];
    const onChainGameStatus = currentGameState?.gameStatus ?? GameStatus.NotStarted;
    
    // Debug: Log state changes
    // Debug: Log game account and delegation status
    useEffect(() => {
        console.log("[UI State]", {
            connected,
            hasGameAccount: !!gameAccount,
            delegationStatus,
            gamePubkey: gamePubkey?.toBase58().substring(0, 8) + "...",
        });
    }, [connected, gameAccount, delegationStatus, gamePubkey]);
    
    useEffect(() => {
        if (currentGameState) {
            const activePipes = pipes.filter(p => p.active);
            console.log("[State Update]", {
                birdY: birdY,
                birdVelocity: currentGameState.birdVelocity / 1000,
                score: displayScore,
                gameStatus: onChainGameStatus,
                activePipes: activePipes.length,
                frameCount: currentGameState.frameCount,
            });
        }
    }, [currentGameState, birdY, pipes, displayScore, onChainGameStatus]);
    
    // Use local isPlaying state OR on-chain status
    const gameStatus = isPlaying ? GameStatus.Playing : onChainGameStatus;
    
    // Sync isPlaying with on-chain state
    useEffect(() => {
        // If on-chain shows Playing but local state is false, sync it
        if (onChainGameStatus === GameStatus.Playing && !isPlaying && delegationStatus === "delegated") {
            console.log("[Game] Syncing isPlaying with on-chain Playing state");
            setIsPlaying(true);
        }
        // If on-chain shows GameOver and local is still playing, sync it
        if (onChainGameStatus === GameStatus.GameOver && isPlaying) {
            console.log("[Game] Game Over detected from on-chain state!");
            setIsPlaying(false);
        }
    }, [onChainGameStatus, isPlaying, delegationStatus]);

    // Handle async actions with error handling
    const handleAction = async (action: () => Promise<string>, actionName: string) => {
        try {
            setPendingTx(true);
            const tx = await action();
            console.log(`${actionName} successful:`, tx);
        } catch (err) {
            console.error(`${actionName} failed:`, err);
        } finally {
            setPendingTx(false);
        }
    };

    // Handle keyboard input - fire ONE flap transaction per SPACE press
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.code === "Space" || e.key === " ") {
                e.preventDefault();
                
                // Ignore if key is being held (repeat) or if flap is pending
                if (e.repeat || isFlapPending.current) {
                    return;
                }
                
                // Only flap if we're playing
                if (isPlaying) {
                    console.log("[Input] SPACE pressed - sending flap");
                    isFlapPending.current = true;
                    flapRef.current()
                        .then(() => {
                            console.log("[Input] Flap transaction sent");
                        })
                        .catch(err => console.error("Flap failed:", err))
                        .finally(() => {
                            isFlapPending.current = false;
                        });
                } else {
                    console.log("[Input] SPACE pressed but not playing");
                }
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isPlaying]); // Only depend on isPlaying, use flapRef for the function

    // Handle click/touch - flap on canvas click (one per click)
    const handleCanvasClick = useCallback(() => {
        if (isPlaying && !isFlapPending.current) {
            console.log("[Input] Canvas clicked - sending flap");
            isFlapPending.current = true;
            flapRef.current()
                .then(() => {
                    console.log("[Input] Flap transaction sent");
                })
                .catch(err => console.error("Flap failed:", err))
                .finally(() => {
                    isFlapPending.current = false;
                });
        }
    }, [isPlaying]);

    // Game loop for rendering (uses on-chain state)
    useEffect(() => {
        if (!canvasRef.current) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const render = () => {
            // Clear canvas
            ctx.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

            // Draw sky gradient
            const gradient = ctx.createLinearGradient(0, 0, 0, GAME_HEIGHT);
            gradient.addColorStop(0, "#87CEEB");
            gradient.addColorStop(1, "#E0F6FF");
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

            // Draw ground
            ctx.fillStyle = "#8B4513";
            ctx.fillRect(0, GAME_HEIGHT - 20, GAME_WIDTH, 20);
            ctx.fillStyle = "#228B22";
            ctx.fillRect(0, GAME_HEIGHT - 25, GAME_WIDTH, 5);

            // Draw pipes from on-chain state
            for (const pipe of pipes) {
                if (!pipe.active) continue;

                const gapTop = pipe.gapY - PIPE_GAP / 2;
                const gapBottom = pipe.gapY + PIPE_GAP / 2;

                // Pipe gradient
                const pipeGradient = ctx.createLinearGradient(pipe.x, 0, pipe.x + PIPE_WIDTH, 0);
                pipeGradient.addColorStop(0, "#228B22");
                pipeGradient.addColorStop(0.5, "#32CD32");
                pipeGradient.addColorStop(1, "#228B22");
                ctx.fillStyle = pipeGradient;

                // Top pipe
                ctx.fillRect(pipe.x, 0, PIPE_WIDTH, gapTop);
                // Top pipe cap
                ctx.fillRect(pipe.x - 3, gapTop - 20, PIPE_WIDTH + 6, 20);

                // Bottom pipe
                ctx.fillRect(pipe.x, gapBottom, PIPE_WIDTH, GAME_HEIGHT - gapBottom - 20);
                // Bottom pipe cap
                ctx.fillRect(pipe.x - 3, gapBottom, PIPE_WIDTH + 6, 20);
            }

            // Draw bird
            const birdCenterX = BIRD_X + BIRD_SIZE / 2;
            const birdCenterY = birdY + BIRD_SIZE / 2;

            // Bird body
            ctx.fillStyle = "#FFD700";
            ctx.beginPath();
            ctx.ellipse(birdCenterX, birdCenterY, BIRD_SIZE / 2, BIRD_SIZE / 2 - 3, 0, 0, Math.PI * 2);
            ctx.fill();

            // Bird beak
            ctx.fillStyle = "#FF6347";
            ctx.beginPath();
            ctx.moveTo(birdCenterX + BIRD_SIZE / 2 - 5, birdCenterY);
            ctx.lineTo(birdCenterX + BIRD_SIZE / 2 + 8, birdCenterY + 3);
            ctx.lineTo(birdCenterX + BIRD_SIZE / 2 - 5, birdCenterY + 6);
            ctx.fill();

            // Bird eye
            ctx.fillStyle = "#FFFFFF";
            ctx.beginPath();
            ctx.arc(birdCenterX + 5, birdCenterY - 3, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#000000";
            ctx.beginPath();
            ctx.arc(birdCenterX + 7, birdCenterY - 3, 3, 0, Math.PI * 2);
            ctx.fill();

            // Bird wing
            ctx.fillStyle = "#DAA520";
            ctx.beginPath();
            ctx.ellipse(birdCenterX - 5, birdCenterY + 5, 8, 4, -0.3, 0, Math.PI * 2);
            ctx.fill();

            // Draw score on canvas
            ctx.fillStyle = "#FFFFFF";
            ctx.strokeStyle = "#000000";
            ctx.lineWidth = 3;
            ctx.font = "bold 36px Arial";
            ctx.textAlign = "center";
            ctx.strokeText(displayScore.toString(), GAME_WIDTH / 2, 50);
            ctx.fillText(displayScore.toString(), GAME_WIDTH / 2, 50);

            // Draw game status overlay
            if (gameStatus === GameStatus.NotStarted) {
                ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
                ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
                ctx.fillStyle = "#FFFFFF";
                ctx.font = "bold 28px Arial";
                ctx.textAlign = "center";
                ctx.fillText("Press Start to Play!", GAME_WIDTH / 2, GAME_HEIGHT / 2);
                ctx.font = "16px Arial";
                ctx.fillText("Delegate first for 10ms transactions!", GAME_WIDTH / 2, GAME_HEIGHT / 2 + 30);
            } else if (gameStatus === GameStatus.GameOver) {
                ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
                ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
                ctx.fillStyle = "#FF6347";
                ctx.font = "bold 36px Arial";
                ctx.textAlign = "center";
                ctx.fillText("GAME OVER", GAME_WIDTH / 2, GAME_HEIGHT / 2 - 30);
                ctx.fillStyle = "#FFFFFF";
                ctx.font = "24px Arial";
                ctx.fillText(`Score: ${displayScore}`, GAME_WIDTH / 2, GAME_HEIGHT / 2 + 10);
                ctx.fillText(`High Score: ${displayHighScore}`, GAME_WIDTH / 2, GAME_HEIGHT / 2 + 45);
            }

            gameLoopRef.current = requestAnimationFrame(render);
        };

        render();

        return () => {
            if (gameLoopRef.current) {
                cancelAnimationFrame(gameLoopRef.current);
            }
        };
    }, [birdY, pipes, displayScore, displayHighScore, gameStatus]);

    // Store tick in a ref to avoid stale closures
    const tickRef = useRef(tick);
    useEffect(() => {
        tickRef.current = tick;
    }, [tick]);

    // Store sessionToken in a ref to check if session is active
    const sessionTokenRef = useRef(sessionToken);
    useEffect(() => {
        sessionTokenRef.current = sessionToken;
    }, [sessionToken]);

    // Auto-tick loop - ENABLED on devnet with session keys for seamless gameplay
    const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    useEffect(() => {
        // Only enable auto-tick when:
        // 1. Game is playing
        // 2. Game is delegated to ER
        // 3. Session keys are active (for seamless transactions)
        if (isPlaying && delegationStatus === "delegated" && sessionToken != null) {
            const tickInterval = 100; // 10fps on devnet
            
            console.log(`[Tick Loop] Starting auto-tick every ${tickInterval}ms (session active)`);
            
            tickIntervalRef.current = setInterval(async () => {
                try {
                    await tickRef.current();
                } catch (err) {
                    console.debug("[Tick] error:", err);
                }
            }, tickInterval);
            
            return () => {
                if (tickIntervalRef.current) {
                    console.log("[Tick Loop] Stopping auto-tick");
                    clearInterval(tickIntervalRef.current);
                    tickIntervalRef.current = null;
                }
            };
        } else if (isPlaying && delegationStatus === "delegated") {
            console.log("[Tick Loop] Auto-tick disabled - no session token. Enable seamless authorization for auto-tick.");
        }
    }, [isPlaying, delegationStatus, sessionToken]);

    // Start game handler - only call once
    const handleStartGame = async () => {
        if (delegationStatus !== "delegated" || isStartingGame || isPlaying) {
            console.log("Cannot start: delegated=", delegationStatus, "starting=", isStartingGame, "playing=", isPlaying);
            return;
        }
        setIsStartingGame(true);
        try {
            const tx = await startGame();
            console.log("Game started:", tx);
            setIsPlaying(true); // Set local playing state immediately
        } catch (err) {
            console.error("Start game failed:", err);
        } finally {
            setIsStartingGame(false);
        }
    };

    // Reset game handler
    const handleResetGame = async () => {
        setIsPlaying(false); // Reset local state first
        await handleAction(resetGame, "Reset Game");
    };

    return (
        <div className="w-full max-w-8xl mx-auto">
            {/* Not connected state */}
            {!connected || !publicKey ? (
                <Card className="max-w-md mx-auto">
                    <CardContent className="pt-6 text-center">
                        <h2 className="text-2xl font-bold mb-4">🎮 On-Chain Flappy Bird</h2>
                        <p className="text-gray-500 mb-4">
                            Fully on-chain game powered by MagicBlock Ephemeral Rollups
                        </p>
                        <p className="text-sm text-gray-400 mb-6">
                            Experience 10ms transaction latency with all game logic on Solana!
                        </p>
                        <WalletMultiButton />
                    </CardContent>
                </Card>
            ) : isCheckingAccount ? (
                /* Loading state while checking account */
                <Card className="max-w-md mx-auto">
                    <CardContent className="pt-6 text-center">
                        <h2 className="text-2xl font-bold mb-4">🎮 On-Chain Flappy Bird</h2>
                        <p className="text-gray-500 mb-4">Checking game account...</p>
                        <div className="animate-spin w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full mx-auto"></div>
                    </CardContent>
                </Card>
            ) : !isInitialized ? (
                /* No game initialized state */
                <Card className="max-w-md mx-auto">
                    <CardHeader>
                        <CardTitle>🎮 Initialize Your Game</CardTitle>
                        {gamePubkey && (
                            <p className="text-xs font-mono text-gray-500 break-all">
                                Game PDA: {gamePubkey.toBase58()}
                            </p>
                        )}
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <p className="text-sm text-gray-600">
                            Create your on-chain game account to start playing Flappy Bird!
                            All game logic runs on Solana with MagicBlock's Ephemeral Rollups.
                        </p>
                        <Button
                            onClick={() => handleAction(initialize, "Initialize")}
                            disabled={isLoading}
                            className="w-full bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600"
                        >
                            {isLoading ? "Creating..." : "🚀 Initialize Game"}
                        </Button>

                        {error && (
                            <div className="p-3 rounded bg-red-50 border border-red-200 text-red-700 text-sm">
                                {error}
                            </div>
                        )}
                    </CardContent>
                </Card>
            ) : (
                /* Game interface - horizontal layout */
                <div className="flex flex-row gap-6 items-start">
                    {/* Left side: Game Canvas */}
                    <div className="flex-shrink-0">
                        <Card>
                            <CardHeader className="">
                                <div className="flex items-center justify-between">
                                    <CardTitle className="flex items-center gap-2 text-lg">
                                        🎮 Flappy Bird
                                    </CardTitle>
                                    <StatusBadge status={delegationStatus} />
                                </div>
                            </CardHeader>
                            <CardContent className="pt-2">
                                {/* Score display */}
                                <div className="flex justify-between items-center bg-gray-50 rounded-lg p-2 mb-3">
                                    <div>
                                        <div className="text-xs text-gray-500">Score</div>
                                        <div className="text-2xl font-bold text-gray-900">{displayScore}</div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-xs text-gray-500">High Score</div>
                                        <div className="text-2xl font-bold text-yellow-500">{displayHighScore}</div>
                                    </div>
                                </div>

                                {/* Game canvas */}
                                <canvas
                                    ref={canvasRef}
                                    width={GAME_WIDTH}
                                    height={GAME_HEIGHT}
                                    onClick={handleCanvasClick}
                                    className="border-4 border-gray-800 rounded-lg cursor-pointer shadow-lg"
                                    style={{ touchAction: "none" }}
                                />
                                
                                {/* Start/Reset button below canvas */}
                                <div className="mt-3">
                                    {delegationStatus !== "delegated" ? (
                                        <div className="text-center p-2 bg-yellow-50 rounded-lg border border-yellow-200">
                                            <p className="text-yellow-800 font-medium text-sm">⚠️ Delegate First!</p>
                                        </div>
                                    ) : gameStatus === GameStatus.NotStarted ? (
                                        <Button
                                            onClick={handleStartGame}
                                            disabled={isLoading || isStartingGame}
                                            className="w-full bg-green-600 hover:bg-green-700 text-white"
                                        >
                                            {isStartingGame ? "Starting..." : "🎮 Start Game"}
                                        </Button>
                                    ) : gameStatus === GameStatus.GameOver ? (
                                        <Button
                                            onClick={handleResetGame}
                                            disabled={isLoading || pendingTx}
                                            className="w-full bg-blue-600 hover:bg-blue-700 text-white"
                                        >
                                            🔄 Play Again
                                        </Button>
                                    ) : (
                                        <div className="text-center py-2 bg-gray-50 rounded-lg">
                                            <p className="text-sm font-medium text-gray-700">
                                                Press <kbd className="px-1 py-0.5 bg-gray-200 rounded text-xs">SPACE</kbd> or click to flap!
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Right side: Controls & Stats */}
                    <div className="flex-1 space-y-4 min-w-[300px]">
                        {/* Stats Card */}
                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-lg">📊 Game Stats</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="space-y-2 text-sm">
                                    <div className="flex justify-between">
                                        <span className="text-gray-500">Game PDA:</span>
                                        <span className="font-mono text-xs">{gamePubkey?.toBase58().slice(0, 8)}...{gamePubkey?.toBase58().slice(-8)}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-gray-500">TX Count:</span>
                                        <span className="font-bold">{txCount}</span>
                                    </div>
                                    {lastTxTime && (
                                        <div className="flex justify-between">
                                            <span className="text-gray-500">Last TX:</span>
                                            <span className="font-bold text-green-600">{lastTxTime}ms</span>
                                        </div>
                                    )}
                                    <div className="flex justify-between">
                                        <span className="text-gray-500">Session:</span>
                                        <span className={sessionToken ? "text-green-600" : "text-yellow-600"}>
                                            {sessionToken ? " Active" : " Not Active"}
                                        </span>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        {/* Ephemeral Rollup Controls */}
                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-lg">⚡ Ephemeral Rollup Controls</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                <div className="grid grid-cols-2 gap-2">
                                    <Button
                                        onClick={() => handleAction(delegate, "Delegate")}
                                        disabled={isLoading || delegationStatus === "delegated"}
                                        className="bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-50"
                                        size="sm"
                                    >
                                        {isDelegating ? "..." : "⬆️ Delegate"}
                                    </Button>

                                    <Button
                                        onClick={() => handleAction(commit, "Commit")}
                                        disabled={isLoading || delegationStatus !== "delegated"}
                                        variant="outline"
                                        size="sm"
                                    >
                                        💾 Commit
                                    </Button>

                                    <Button
                                        onClick={() => handleAction(undelegate, "Undelegate")}
                                        disabled={isLoading || delegationStatus !== "delegated"}
                                        variant="outline"
                                        size="sm"
                                    >
                                        ⬇️ Undelegate
                                    </Button>

                                    <Button
                                        onClick={() => checkDelegation()}
                                        variant="ghost"
                                        size="sm"
                                        disabled={isLoading}
                                    >
                                        🔄 Refresh
                                    </Button>
                                </div>

                                {delegationStatus === "delegated" && !sessionToken && (
                                    <Button
                                        onClick={() => handleAction(async () => {
                                            await createSession();
                                            return "Session Created";
                                        }, "Create Session")}
                                        disabled={isSessionLoading || isLoading}
                                        className="w-full bg-gradient-to-r from-yellow-400 to-orange-500 text-white"
                                    >
                                        {isSessionLoading ? "Creating..." : "⚡ Enable Seamless Authorization"}
                                    </Button>
                                )}

                                {sessionToken && delegationStatus === "delegated" && (
                                    <div className="text-center bg-green-50 rounded-lg p-2">
                                        <p className="text-sm text-green-600 font-medium">
                                            ⚡ Seamless Mode Active!
                                        </p>
                                    </div>
                                )}

                                {/* Error display */}
                                {error && (
                                    <div className="p-2 rounded bg-red-50 border border-red-200 text-red-700 text-xs">
                                        {error}
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        {/* Info Card */}
                        <Card>
                            <CardContent className="pt-4">
                                <h3 className="font-medium text-gray-900 mb-2">How it works:</h3>
                                <ul className="text-xs text-gray-600 space-y-1">
                                    <li>1. <strong>Initialize</strong> - Create game account on Solana</li>
                                    <li>2. <strong>Delegate</strong> - Move to Ephemeral Rollup</li>
                                    <li>3. <strong>Enable Seamless</strong> - Session key for auto-signing</li>
                                    <li>4. <strong>Play</strong> - Every action = on-chain TX!</li>
                                    <li>5. <strong>Commit</strong> - Save high score to base layer</li>
                                </ul>
                            </CardContent>
                        </Card>
                    </div>
                </div>
            )}
        </div>
    );
}
