import { useState, useEffect, useRef, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useGameState, type DelegationStatus, GameStatus } from "../providers/GameStateProvider";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

// Game constants - MUST match program values!
const CANVAS_WIDTH = 500;  // Matches GAME_WIDTH in lib.rs
const CANVAS_HEIGHT = 400; // Matches GAME_HEIGHT in lib.rs
const BIRD_SIZE = 30;      // Matches BIRD_SIZE in lib.rs
const PIPE_WIDTH = 60;     // Matches PIPE_WIDTH in lib.rs
const PIPE_GAP = 160;      // Matches PIPE_GAP in lib.rs (slightly larger for easier play)

// Local simulation fallback when not delegated
const GRAVITY = 0.4;       // Matches GRAVITY/1000 in lib.rs
const JUMP_STRENGTH = -6;  // Matches JUMP_VELOCITY/1000 in lib.rs
const PIPE_SPEED = 4;      // Matches PIPE_SPEED in lib.rs
const PIPE_SPACING = 250;  // Matches PIPE_SPAWN_DISTANCE in lib.rs

// Badge component for delegation status
function StatusBadge({ status }: { status: DelegationStatus }) {
    const styles: Record<DelegationStatus, { bg: string; text: string; label: string }> = {
        undelegated: { bg: "bg-gray-100", text: "text-gray-900", label: "Base Layer" },
        delegated: { bg: "bg-black", text: "text-white", label: "Delegated to ER" },
        checking: { bg: "bg-gray-100", text: "text-gray-500", label: "Checking..." },
    };

    const style = styles[status];

    return (
        <span className={`px-2 py-1 rounded-full text-xs font-medium ${style.bg} ${style.text}`}>
            {style.label}
        </span>
    );
}

interface Pipe {
    x: number;
    topHeight: number;
    bottomY: number;
    passed: boolean;
}

export function FlappyBird() {
    const { publicKey, connected } = useWallet();
    const {
        gameAccount,
        gamePubkey,
        isLoading,
        error,
        initialize,
        startGame,
        endGame,
        resetGame,
        // ER operations
        delegate,
        commit,
        undelegate,
        flap: flapOnER,
        tick: tickOnER,
        delegationStatus,
        erGameAccount: erGameValue,
        checkDelegation,
        createSession,
        sessionToken,
        isSessionLoading,
        isDelegating,
    } = useGameState();

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animationFrameRef = useRef<number | null>(null);
    const [gameStarted, setGameStarted] = useState(false);
    const [gameOver, setGameOver] = useState(false);
    const [localScore, setLocalScore] = useState(0);
    
    // Use refs for frequently changing game state
    const birdYRef = useRef(250);
    const birdVelocityRef = useRef(0);
    const pipesRef = useRef<Pipe[]>([]);
    const lastPipeXRef = useRef(CANVAS_WIDTH);
    
    // CRITICAL: Use a ref to hold the latest erGameValue for the render loop
    // This prevents stale closure issues in requestAnimationFrame
    const erGameValueRef = useRef(erGameValue);
    useEffect(() => {
        erGameValueRef.current = erGameValue;
    }, [erGameValue]);
    
    // Sync local game state with on-chain state when delegated
    useEffect(() => {
        if (delegationStatus === "delegated" && erGameValue) {
            const onChainStatus = erGameValue.gameStatus;
            if (onChainStatus === GameStatus.Playing) {
                setGameStarted(true);
                setGameOver(false);
            } else if (onChainStatus === GameStatus.GameOver) {
                setGameOver(true);
            } else if (onChainStatus === GameStatus.NotStarted) {
                setGameStarted(false);
                setGameOver(false);
            }
        }
    }, [delegationStatus, erGameValue]);
    
    // State for rendering
    const [birdY, setBirdY] = useState(250);
    const [pipes, setPipes] = useState<Pipe[]>([]);

    // Get display values from ER state or local state
    const displayScore = delegationStatus === "delegated" && erGameValue?.score !== undefined
        ? erGameValue.score
        : localScore;
    
    const displayHighScore = delegationStatus === "delegated" && erGameValue?.highScore !== undefined
        ? erGameValue.highScore
        : gameAccount?.highScore ?? 0;

    // Handle actions
    const handleAction = async (action: () => Promise<string>, actionName: string) => {
        try {
            const tx = await action();
            console.log(`${actionName} successful:`, tx);
        } catch (err) {
            console.error(`${actionName} failed:`, err);
        }
    };

    // Jump function - sends on-chain flap when delegated
    const jump = useCallback(() => {
        if (!gameStarted || gameOver) return;
        
        if (delegationStatus === "delegated") {
            // FULLY ON-CHAIN: Send flap transaction to ER (fire and forget)
            flapOnER().catch(() => {});
        } else {
            // Local simulation fallback when not delegated
            birdVelocityRef.current = JUMP_STRENGTH;
        }
    }, [gameStarted, gameOver, delegationStatus, flapOnER]);

    // Handle keyboard input
    useEffect(() => {
        const handleKeyPress = (e: KeyboardEvent) => {
            if (e.code === "Space" || e.key === " ") {
                e.preventDefault();
                jump();
            }
        };

        window.addEventListener("keydown", handleKeyPress);
        return () => window.removeEventListener("keydown", handleKeyPress);
    }, [jump]);

    // Handle click/touch
    const handleCanvasClick = () => {
        jump();
    };

    // Game loop - supports both on-chain (ER) and local simulation modes
    useEffect(() => {
        if (!gameStarted || gameOver || !canvasRef.current) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // On-chain mode: render directly from erGameValue (no client prediction)
        if (delegationStatus === "delegated") {
            // Tick interval - send tick transactions to advance on-chain physics
            const tickInterval = setInterval(() => {
                tickOnER().catch(() => {}); // Fire and forget
            }, 50); // 20 TPS

            // Render loop - just draw whatever on-chain state we have
            const renderLoop = () => {
                ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

                // Draw sky
                ctx.fillStyle = "#87CEEB";
                ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

                // Get on-chain state from ref
                const currentErState = erGameValueRef.current;
                const birdY = (currentErState?.birdY ?? 200000) / 1000;
                const pipes = currentErState?.pipes ?? [];
                const gameStatus = currentErState?.gameStatus;

                // Check if game over on-chain
                if (gameStatus === GameStatus.GameOver) {
                    setGameOver(true);
                    clearInterval(tickInterval);
                    return;
                }

                // Draw pipes directly from on-chain state
                ctx.fillStyle = "#228B22";
                for (const pipe of pipes) {
                    if (!pipe.active) continue;
                    const gapCenterY = pipe.gapY;
                    const topHeight = gapCenterY - PIPE_GAP / 2;
                    const bottomY = gapCenterY + PIPE_GAP / 2;
                    
                    // Top pipe
                    ctx.fillRect(pipe.x, 0, PIPE_WIDTH, topHeight);
                    // Bottom pipe
                    ctx.fillRect(pipe.x, bottomY, PIPE_WIDTH, CANVAS_HEIGHT - bottomY);
                }

                // Draw bird from on-chain state
                ctx.fillStyle = "#FFD700";
                ctx.beginPath();
                ctx.arc(50, birdY + BIRD_SIZE / 2, BIRD_SIZE / 2, 0, Math.PI * 2);
                ctx.fill();

                // Draw "ON-CHAIN" indicator
                ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
                ctx.fillRect(CANVAS_WIDTH - 100, 10, 90, 25);
                ctx.fillStyle = "#00FF00";
                ctx.font = "12px monospace";
                ctx.fillText("⚡ ON-CHAIN", CANVAS_WIDTH - 95, 27);

                animationFrameRef.current = requestAnimationFrame(renderLoop);
            };

            animationFrameRef.current = requestAnimationFrame(renderLoop);

            return () => {
                clearInterval(tickInterval);
                if (animationFrameRef.current) {
                    cancelAnimationFrame(animationFrameRef.current);
                }
            };
        }

        // LOCAL SIMULATION MODE (when not delegated)
        const gameLoop = () => {
            // Update bird physics
            birdVelocityRef.current += GRAVITY;
            birdYRef.current = Math.max(0, Math.min(CANVAS_HEIGHT - BIRD_SIZE, birdYRef.current + birdVelocityRef.current));
            
            // Update bird Y for rendering (throttled)
            setBirdY(birdYRef.current);

            // Update pipes
            const currentPipes = pipesRef.current.map((pipe) => ({
                ...pipe,
                x: pipe.x - PIPE_SPEED,
            }));

            // Remove off-screen pipes
            const filtered = currentPipes.filter((pipe) => pipe.x + PIPE_WIDTH > 0);

            // Add new pipes
            const lastPipe = filtered[filtered.length - 1];
            if (filtered.length === 0 || (lastPipe && lastPipe.x < CANVAS_WIDTH - PIPE_SPACING)) {
                const topHeight = Math.random() * (CANVAS_HEIGHT - PIPE_GAP - 100) + 50;
                filtered.push({
                    x: CANVAS_WIDTH,
                    topHeight,
                    bottomY: topHeight + PIPE_GAP,
                    passed: false,
                });
            }

            pipesRef.current = filtered;
            setPipes([...filtered]); // Update for rendering

            // Check collisions
            const currentBirdY = birdYRef.current;

            for (const pipe of filtered) {
                // Check if bird passed pipe
                if (!pipe.passed && pipe.x + PIPE_WIDTH < 50) {
                    const newScore = localScore + 1;
                    setLocalScore(newScore);
                    pipe.passed = true;
                    // Note: Score is updated on-chain in the tick instruction automatically
                }

                // Check collision
                if (
                    pipe.x < 50 + BIRD_SIZE &&
                    pipe.x + PIPE_WIDTH > 50 &&
                    (currentBirdY < pipe.topHeight || currentBirdY + BIRD_SIZE > pipe.bottomY)
                ) {
                    setGameOver(true);
                    handleAction(endGame, "End Game");
                    return;
                }
            }

            // Check ground/ceiling collision
            if (currentBirdY <= 0 || currentBirdY + BIRD_SIZE >= CANVAS_HEIGHT) {
                setGameOver(true);
                handleAction(endGame, "End Game");
                return;
            }

            // Draw
            ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

            // Draw sky
            ctx.fillStyle = "#87CEEB";
            ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

            // Draw pipes
            ctx.fillStyle = "#228B22";
            for (const pipe of filtered) {
                // Top pipe
                ctx.fillRect(pipe.x, 0, PIPE_WIDTH, pipe.topHeight);
                // Bottom pipe
                ctx.fillRect(pipe.x, pipe.bottomY, PIPE_WIDTH, CANVAS_HEIGHT - pipe.bottomY);
            }

            // Draw bird
            ctx.fillStyle = "#FFD700";
            ctx.beginPath();
            ctx.arc(50, currentBirdY + BIRD_SIZE / 2, BIRD_SIZE / 2, 0, Math.PI * 2);
            ctx.fill();

            animationFrameRef.current = requestAnimationFrame(gameLoop);
        };

        animationFrameRef.current = requestAnimationFrame(gameLoop);

        return () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
        };
    }, [gameStarted, gameOver, localScore, delegationStatus, endGame, handleAction, tickOnER]);

    // Start game handler - always use startGame which handles both ER and base layer
    const handleStartGame = async () => {
        // Reset local state
        setLocalScore(0);
        birdYRef.current = 250;
        birdVelocityRef.current = 0;
        pipesRef.current = [];
        lastPipeXRef.current = CANVAS_WIDTH;
        setBirdY(250);
        setPipes([]);

        // Start game on-chain - state will sync via useEffect
        await handleAction(startGame, "Start Game");
    };

    // Reset game handler - reset and immediately start a new game
    const handleResetGame = async () => {
        // Reset local state first
        setLocalScore(0);
        birdYRef.current = 250;
        birdVelocityRef.current = 0;
        pipesRef.current = [];
        lastPipeXRef.current = CANVAS_WIDTH;
        setBirdY(250);
        setPipes([]);

        try {
            // Reset on-chain first
            console.log("Resetting game on-chain...");
            await resetGame();
            
            // Small delay for state to propagate
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // Now start a new game
            console.log("Starting new game on-chain...");
            await startGame();
            
            console.log("Game reset and started successfully!");
            // Note: gameStarted/gameOver state will be synced by the useEffect
        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            // If game is already started, that's fine - the UI will sync from on-chain state
            if (!errorMsg.includes("6001") && !errorMsg.includes("GameAlreadyStarted")) {
                console.error("Reset/Start failed:", errorMsg);
            }
        }
    };

    // Get explorer URL
    const getExplorerUrl = (address: string, type: "address" | "tx" = "address") => {
        return `https://explorer.solana.com/${type}/${address}?cluster=devnet`;
    };

    return (
        <div className="max-w-lg mx-auto space-y-4">
            {/* Not connected state */}
            {!connected || !publicKey ? (
                <Card>
                    <CardContent className="pt-6">
                        <p className="text-center text-gray-500">
                            Connect your wallet to play Flappy Bird on Solana
                        </p>
                    </CardContent>
                </Card>
            ) : !gameAccount && delegationStatus !== "delegated" ? (
                /* No game initialized state */
                <Card>
                    <CardHeader>
                        <CardTitle>Initialize Game</CardTitle>
                        {gamePubkey && (
                            <p className="text-xs font-mono text-gray-500 break-all">
                                PDA: {gamePubkey.toBase58()}
                            </p>
                        )}
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <p className="text-sm text-gray-600">
                            Initialize your game account to start playing Flappy Bird on-chain!
                        </p>
                        <Button
                            onClick={() => handleAction(initialize, "Initialize")}
                            disabled={isLoading}
                            className="w-full"
                        >
                            {isLoading ? "Creating..." : "Initialize Game"}
                        </Button>

                        {error && (
                            <div className="p-3 rounded bg-gray-50 border border-gray-200 text-gray-900 text-sm font-medium">
                                {error}
                            </div>
                        )}
                    </CardContent>
                </Card>
            ) : (
                /* Game interface */
                <>
                    {/* Game Display Card */}
                    <Card>
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <CardTitle>Flappy Bird</CardTitle>
                                <StatusBadge status={delegationStatus} />
                            </div>
                            <p className="text-xs font-mono text-gray-500 break-all">
                                {gamePubkey?.toBase58()}
                            </p>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            {/* Score display */}
                            <div className="text-center">
                                <div className="text-4xl font-bold text-gray-900">
                                    Score: {displayScore}
                                </div>
                                <div className="text-lg text-gray-600 mt-2">
                                    High Score: {displayHighScore}
                                </div>
                            </div>

                            {/* Game canvas */}
                            <div className="flex justify-center">
                                <canvas
                                    ref={canvasRef}
                                    width={CANVAS_WIDTH}
                                    height={CANVAS_HEIGHT}
                                    onClick={handleCanvasClick}
                                    className="border-2 border-gray-300 rounded-lg cursor-pointer bg-sky-300"
                                    style={{ touchAction: "none" }}
                                />
                            </div>

                            {/* Game controls */}
                            <div className="space-y-3">
                                {!gameStarted ? (
                                    <Button
                                        onClick={handleStartGame}
                                        disabled={isLoading}
                                        className="w-full bg-green-600 hover:bg-green-700 text-white"
                                    >
                                        Start Game
                                    </Button>
                                ) : gameOver ? (
                                    <>
                                        <div className="text-center py-2">
                                            <p className="text-lg font-bold text-red-600">Game Over!</p>
                                            <p className="text-sm text-gray-600">Final Score: {displayScore}</p>
                                        </div>
                                        <Button
                                            onClick={handleResetGame}
                                            disabled={isLoading}
                                            className="w-full bg-blue-600 hover:bg-blue-700 text-white"
                                        >
                                            Play Again
                                        </Button>
                                    </>
                                ) : (
                                    <div className="text-center py-2">
                                        <p className="text-sm text-gray-600">Press SPACE or click to jump</p>
                                    </div>
                                )}
                            </div>

                            {/* Divider with label */}
                            <div className="relative">
                                <div className="absolute inset-0 flex items-center">
                                    <span className="w-full border-t" />
                                </div>
                                <div className="relative flex justify-center text-xs uppercase">
                                    <span className="bg-white px-2 text-gray-500">
                                        Ephemeral Rollup Actions
                                    </span>
                                </div>
                            </div>

                            {/* Ephemeral Rollup Actions */}
                            <div className="space-y-3">
                                {delegationStatus === "checking" ? (
                                    <div className="text-center py-2">
                                        <p className="text-sm text-gray-500">Checking delegation status...</p>
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-2 gap-3">
                                        <Button
                                            onClick={() => handleAction(delegate, "Delegate")}
                                            disabled={isLoading || delegationStatus === "delegated"}
                                            className="col-span-2 bg-black text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            {isDelegating ? "Delegating..." : "Delegate to ER"}
                                        </Button>

                                        {delegationStatus === "delegated" && !sessionToken && (
                                            <Button
                                                onClick={() => handleAction(async () => {
                                                    await createSession();
                                                    return "Session Created";
                                                }, "Create Session")}
                                                disabled={isSessionLoading || isLoading}
                                                className="col-span-2 bg-gray-900 text-white border-2 border-gray-900"
                                            >
                                                {isSessionLoading ? "Creating Session..." : "Enable Seamless Mode ⚡"}
                                            </Button>
                                        )}

                                        <Button
                                            onClick={() => handleAction(commit, "Commit")}
                                            disabled={isLoading || delegationStatus !== "delegated"}
                                            variant="outline"
                                            className="border-gray-300 text-gray-900 hover:bg-gray-50 disabled:opacity-50"
                                        >
                                            Commit High Score
                                        </Button>

                                        <Button
                                            onClick={() => handleAction(undelegate, "Undelegate")}
                                            disabled={isLoading || delegationStatus !== "delegated"}
                                            variant="outline"
                                            className="border-gray-300 text-gray-900 hover:bg-gray-50 disabled:opacity-50"
                                        >
                                            Undelegate
                                        </Button>
                                    </div>
                                )}

                                {sessionToken && delegationStatus === "delegated" && (
                                    <div className="text-center">
                                        <p className="text-xs text-green-600 font-medium">
                                            ⚡ Seamless Mode Active
                                        </p>
                                    </div>
                                )}

                                <Button
                                    onClick={() => checkDelegation()}
                                    variant="ghost"
                                    size="sm"
                                    className="w-full text-xs text-gray-400"
                                    disabled={isLoading}
                                >
                                    Refresh Status
                                </Button>
                            </div>

                            {/* Error display */}
                            {error && (
                                <div className="p-3 rounded bg-gray-50 border border-gray-200 text-gray-900 text-sm font-medium">
                                    {error}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </>
            )}
        </div>
    );
}

