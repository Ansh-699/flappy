import { useState, useEffect, useRef, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useFlappyBirdProgram, type DelegationStatus } from "../hooks/use-flappy-bird-program";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

// Game constants - MUST match program values!
const CANVAS_WIDTH = 600;  // Matches GAME_WIDTH in lib.rs
const CANVAS_HEIGHT = 400; // Matches GAME_HEIGHT in lib.rs
const BIRD_SIZE = 30;      // Matches BIRD_SIZE in lib.rs
// Note the Pipe Width in lib.rs is 60! 
const PIPE_WIDTH = 60;
const PIPE_GAP = 150;      // Matches PIPE_GAP in lib.rs

// Local simulation fallback when not delegated
const GRAVITY = 0.5;
const JUMP_STRENGTH = -8;
const PIPE_SPEED = 2;
const PIPE_SPACING = 200;

// --- ASSETS ---
// Simple inline SVG strings for "premium" feel without external files
const BIRD_SVG = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#FFD700" stroke="#DAA520" stroke-width="2"/><circle cx="24" cy="12" r="4" fill="#FFFFFF"/><circle cx="25" cy="12" r="1.5" fill="#000000"/><path d="M 16 22 Q 22 26 28 20" stroke="#E65100" stroke-width="3" fill="none"/></svg>')}`;

const CLOUD_SVG = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><path d="M 10 25 C 10 25 15 15 25 15 C 25 15 30 5 40 10 C 40 10 50 5 55 15 C 55 15 65 20 60 28 L 10 28 Z" fill="#FFFFFF" opacity="0.8"/></svg>')}`;

const PIPE_HEAD_SVG = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 30"><rect width="60" height="30" fill="#2E7D32" stroke="#1B5E20" stroke-width="2"/><rect x="5" y="5" width="4" height="20" fill="#4CAF50" opacity="0.5"/></svg>')}`;
const PIPE_BODY_SVG = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 10"><rect width="60" height="10" fill="#388E3C" stroke="#1B5E20" stroke-width="2"/><rect x="8" y="0" width="6" height="10" fill="#66BB6A" opacity="0.3"/></svg>')}`;

// Log Interface
interface LogEntry {
    time: string;
    type: 'tick' | 'flap' | 'info' | 'error';
    hash?: string;
    message?: string;
}

interface Pipe {
    x: number;
    topHeight: number;
    bottomY: number;
    passed: boolean;
    gapY?: number; // Helpers
    active?: boolean;
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
        delegate,
        commit,
        undelegate,
        startGameOnER,
        resetGameOnER,
        flapOnER,
        tickOnER,
        erGameValue,
        sessionToken,
        isSessionLoading,
        createSession,
        delegationStatus,
        isDelegating,
        getLeaderboard // New hook function
    } = useFlappyBirdProgram();

    // Game state
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [gameStarted, setGameStarted] = useState(false);
    const [gameOver, setGameOver] = useState(false);

    // Leaderboard State
    const [leaderboard, setLeaderboard] = useState<{ rank: number, name: string, score: number }[]>([]);

    useEffect(() => {
        // Fetch leaderboard on load and occasional updates
        const fetchLb = async () => {
            const data = await getLeaderboard();
            const formatted = data.map((d, i) => ({
                rank: i + 1,
                name: d.authority.toString().slice(0, 6) + '...' + d.authority.toString().slice(-4),
                score: d.highScore
            }));
            setLeaderboard(formatted);
        };
        fetchLb();
        const interval = setInterval(fetchLb, 10000); // Update every 10s
        return () => clearInterval(interval);
    }, [getLeaderboard]);

    // Logs State
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const logsRef = useRef<LogEntry[]>([]); // Ref for non-blocking access

    const addLog = useCallback((type: LogEntry['type'], message: string, hash?: string) => {
        const entry: LogEntry = {
            time: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 1 }),
            type,
            message,
            hash
        };
        // Keep last 30 logs
        const newLogs = [entry, ...logsRef.current].slice(0, 30);
        logsRef.current = newLogs;
        setLogs(newLogs); // Trigger re-render for UI
    }, []);

    // Asset Refs
    const birdImgMs = useRef<HTMLImageElement | null>(null);
    const cloudImgMs = useRef<HTMLImageElement | null>(null);
    const pipeHeadImgMs = useRef<HTMLImageElement | null>(null);
    const pipeBodyImgMs = useRef<HTMLImageElement | null>(null);

    // Initialize Assets
    useEffect(() => {
        const load = (src: string) => { const img = new Image(); img.src = src; return img; };
        birdImgMs.current = load(BIRD_SVG);
        cloudImgMs.current = load(CLOUD_SVG);
        pipeHeadImgMs.current = load(PIPE_HEAD_SVG);
        pipeBodyImgMs.current = load(PIPE_BODY_SVG);

        addLog('info', 'Assets loaded & GPU ready');
    }, [addLog]);

    // Derived display state
    const displayScore = delegationStatus === "delegated" && erGameValue?.score !== undefined
        ? erGameValue.score.toString()
        : (gameAccount?.score?.toString() ?? "0");

    // Helper for High Score
    const displayHighScore = delegationStatus === "delegated" && erGameValue?.high_score !== undefined
        ? erGameValue.high_score.toString()
        : (gameAccount?.highScore?.toString() ?? "0");

    // Local simulation vars
    const birdYRef = useRef(200);
    const birdVelocityRef = useRef(0);
    const pipesRef = useRef<Pipe[]>([]);
    const frameRef = useRef(0);
    const animationFrameRef = useRef<number>();
    // Cloud parallax state
    const cloudsRef = useRef<{ x: number, y: number, scale: number }[]>([
        { x: 50, y: 50, scale: 1 }, { x: 300, y: 100, scale: 0.8 }, { x: 500, y: 30, scale: 1.2 }
    ]);

    // Handle Actions Wrapper
    const handleAction = async (action: () => Promise<string>, name: string) => {
        try {
            const tx = await action();
            addLog(name === 'tick' ? 'tick' : name === 'flap' ? 'flap' : 'info', `Success`, tx);
        } catch (err) {
            console.error(err);
            addLog('error', `${name} failed`, undefined);
        }
    };

    // Game Functions
    const handleStartGame = async () => {
        if (delegationStatus === "delegated") {
            await handleAction(() => startGameOnER(), "start game");
        } else {
            await handleAction(() => startGame(), "start game");
        }
        setGameStarted(true);
        setGameOver(false);
    };

    const handleResetGame = async () => {
        if (delegationStatus === "delegated") {
            // Directly start new game (skip reset to NotStarted)
            await handleAction(() => startGameOnER(), "restart game");
        } else {
            await handleAction(() => startGame(), "restart game");
        }
        setGameStarted(true);
        setGameOver(false);
        birdYRef.current = CANVAS_HEIGHT / 2;
        birdVelocityRef.current = 0;
        pipesRef.current = [];
    };

    const jump = useCallback(() => {
        if (!gameStarted || gameOver) return;
        if (delegationStatus === "delegated") {
            // Turbo Mode: Fire and forget
            flapOnER(false).then(tx => addLog('flap', 'Jump!', tx)).catch(e => console.error(e));
        } else {
            birdVelocityRef.current = JUMP_STRENGTH; // Local
        }
    }, [gameStarted, gameOver, delegationStatus, flapOnER, addLog]);

    // Input
    useEffect(() => {
        const h = (e: KeyboardEvent) => { if (e.code === "Space" || e.key === " ") { e.preventDefault(); jump(); } };
        window.addEventListener("keydown", h);
        return () => window.removeEventListener("keydown", h);
    }, [jump]);

    // Game Loop
    useEffect(() => {
        if (!gameStarted) return;
        const ctx = canvasRef.current?.getContext("2d");
        if (!ctx) return;

        // -- ON CHAIN TICKER --
        // Use a ref to prevent overlapping tick transactions if strict, but here we want TURBO.
        let localTickInterval: any;
        if (delegationStatus === "delegated" && !gameOver) {
            // 20Hz Ticks
            localTickInterval = setInterval(async () => {
                try {
                    const tx = await tickOnER(false);
                    // logging every tick is spammy, maybe log 1 in 10?
                    if (Math.random() < 0.1) addLog('tick', 'Tick (Sampled)', tx);
                } catch (e) { }
            }, 50);
        }

        const render = () => {
            // 1. Background
            ctx.fillStyle = "#4FC3F7"; // Better sky blue
            ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

            // 2. Clouds (Parallax)
            cloudsRef.current.forEach(cloud => {
                cloud.x -= 0.5 * cloud.scale;
                if (cloud.x < -100) cloud.x = CANVAS_WIDTH + 50;
                if (cloudImgMs.current) {
                    ctx.globalAlpha = 0.8;
                    ctx.drawImage(cloudImgMs.current, cloud.x, cloud.y, 80 * cloud.scale, 40 * cloud.scale);
                    ctx.globalAlpha = 1.0;
                }
            });

            // 3. State Determination
            let targetBirdY = birdYRef.current;
            let targetVelocity = birdVelocityRef.current;
            let pipes: any[] = pipesRef.current;

            if (delegationStatus === "delegated") {
                // Use ER State
                if (erGameValue) {
                    targetBirdY = erGameValue.birdY / 1000;
                    targetVelocity = erGameValue.birdVelocity / 1000;

                    // Interpolate Pipes
                    const targetPipes = erGameValue.pipes || [];
                    if (pipesRef.current.length !== targetPipes.length) {
                        pipesRef.current = JSON.parse(JSON.stringify(targetPipes));
                    } else {
                        targetPipes.forEach((tp: any, i: number) => {
                            const lp = pipesRef.current[i];
                            if (!lp) return; // Safety check

                            if (Math.abs(tp.x - lp.x) > 100) {
                                lp.x = tp.x;
                                lp.gapY = tp.gapY;
                            } else {
                                lp.x += (tp.x - lp.x) * 0.15;
                                lp.gapY += (tp.gapY - lp.gapY) * 0.15;
                            }
                            lp.active = tp.active;
                            lp.passed = tp.passed;
                        });
                    }
                    pipes = pipesRef.current;

                    if (erGameValue.gameStatus === 2 && !gameOver) {
                        setGameOver(true);
                    }
                }
            }

            // --- INTERPOLATION (Smoothing) ---
            // If we are delegated, we LERP; otherwise (local) we use direct value (or simulated physics).
            // LERP factor 0.15 = moves 15% closer to target each frame. Higher = snappier, Lower = smoother but laggy.
            const lerpFactor = 0.15;

            // Initialize if far off (teleport first time)
            if (Math.abs(birdYRef.current - targetBirdY) > 100) {
                birdYRef.current = targetBirdY;
                birdVelocityRef.current = targetVelocity;
            } else {
                birdYRef.current += (targetBirdY - birdYRef.current) * lerpFactor;
                birdVelocityRef.current += (targetVelocity - birdVelocityRef.current) * lerpFactor;
            }

            const renderBirdY = birdYRef.current;
            const renderVelocity = birdVelocityRef.current;

            // 4. Pipes
            pipes.forEach(pipe => {
                if (!pipe.active && delegationStatus === "delegated") return;
                // ER pipe structure: { x, gapY, ... }
                // Need to handle top/bottom
                const px = pipe.x;
                const pGapY = pipe.gapY;

                // Draw Top Pipe
                // Repeats pattern or stretches? Stretches for simple
                if (pipeBodyImgMs.current && pipeHeadImgMs.current) {
                    const topHeight = pGapY - PIPE_GAP / 2;
                    const bottomStart = pGapY + PIPE_GAP / 2;
                    const bottomHeight = CANVAS_HEIGHT - bottomStart;

                    // Upside down top pipe?
                    ctx.save();
                    // Draw body (Green Rect for solidity)
                    ctx.fillStyle = "#2E7D32"; // Dark green matching pipe head
                    ctx.fillRect(px, 0, PIPE_WIDTH, topHeight - 30);

                    // Draw head
                    ctx.drawImage(pipeHeadImgMs.current, px, topHeight - 30, PIPE_WIDTH, 30);

                    // Bottom pipe
                    ctx.drawImage(pipeHeadImgMs.current, px, bottomStart, PIPE_WIDTH, 30);
                    ctx.fillStyle = "#2E7D32";
                    // Draw body
                    ctx.fillRect(px, bottomStart + 30, PIPE_WIDTH, bottomHeight - 30);
                    ctx.restore();
                } else {
                    // Fallback
                    ctx.fillStyle = "#2E7D32";
                    ctx.fillRect(px, 0, PIPE_WIDTH, pGapY - PIPE_GAP / 2);
                    ctx.fillRect(px, pGapY + PIPE_GAP / 2, PIPE_WIDTH, CANVAS_HEIGHT);
                }
            });

            // 5. Bird
            // Add tilt based on velocity if available? 
            ctx.save();
            ctx.translate(50, renderBirdY + BIRD_SIZE / 2);
            // Rotate? If velocity > 0 (falling) rotate down
            // Scale 1000 from ER

            const rotation = Math.min(Math.PI / 4, Math.max(-Math.PI / 4, (renderVelocity * 0.1)));
            ctx.rotate(rotation);

            if (birdImgMs.current) {
                ctx.drawImage(birdImgMs.current, -BIRD_SIZE / 2, -BIRD_SIZE / 2, BIRD_SIZE, BIRD_SIZE);
            } else {
                ctx.fillStyle = "yellow";
                ctx.beginPath(); ctx.arc(0, 0, BIRD_SIZE / 2, 0, Math.PI * 2); ctx.fill();
            }
            ctx.restore();

            // 6. Ground
            ctx.fillStyle = "#8D6E63"; // Earth color
            ctx.fillRect(0, CANVAS_HEIGHT - 20, CANVAS_WIDTH, 20);
            ctx.fillStyle = "#43A047"; // Grass
            ctx.fillRect(0, CANVAS_HEIGHT - 25, CANVAS_WIDTH, 5);

            // 7. Game Over Overlay
            if (gameOver) {
                ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
                ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

                ctx.fillStyle = "white";
                ctx.font = "900 48px sans-serif";
                ctx.textAlign = "center";
                ctx.strokeText("GAME OVER", CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
                ctx.fillText("GAME OVER", CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);

                ctx.font = "bold 24px sans-serif";
                ctx.fillText(`Score: ${displayScore}`, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 50);
            }

            animationFrameRef.current = requestAnimationFrame(render);
        };

        render();
        return () => {
            if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
            if (localTickInterval) clearInterval(localTickInterval);
        };
    }, [gameStarted, delegationStatus, erGameValue, tickOnER, addLog, gameOver, displayScore]);

    // Render UI Layout
    return (
        <div className="w-full max-w-7xl mx-auto p-4">
            <div className="grid grid-cols-12 gap-6 h-[600px]">

                {/* LEFT COLUMN: REAL-TIME LOGS */}
                <Card className="col-span-3 bg-black border-green-900 border-2 flex flex-col overflow-hidden max-h-full">
                    <CardHeader className="bg-green-900/20 py-3 border-b border-green-900">
                        <CardTitle className="text-green-400 font-mono text-sm uppercase tracking-wider flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                            Transactions[Realtime]
                        </CardTitle>
                    </CardHeader>
                    <div className="flex-1 overflow-y-auto p-2 font-mono text-xs space-y-1 bg-black/90 scrollbar-thin scrollbar-thumb-green-900">
                        {logs.length === 0 && <span className="text-green-800 italic">Reading mempool...</span>}
                        {logs.map((log, i) => (
                            <div key={i} className={`flex gap-2 ${log.type === 'error' ? 'text-red-400' : 'text-green-400/90'}`}>
                                <span className="opacity-50">[{log.time}]</span>
                                <span className={log.type === 'flap' ? 'text-yellow-400 font-bold' : ''}>
                                    {log.type === 'tick' ? 'TICK' : log.type.toUpperCase()}
                                </span>
                                {log.hash && (
                                    <a
                                        href={`https://explorer.solana.com/tx/${log.hash}?cluster=devnet`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="hover:underline opacity-70 truncate max-w-[100px]"
                                    >
                                        {log.hash.slice(0, 30)}...
                                    </a>
                                )}
                            </div>
                        ))}
                    </div>
                </Card>

                {/* CENTER COLUMN: GAME */}
                <div className="col-span-6 flex flex-col gap-4">
                    <Card className="relative border-4 border-slate-800 bg-sky-300 shadow-2xl overflow-hidden">
                        {/* Score Overlay - Hidden if Game Over (drawn on canvas instead) */}
                        {!gameOver && (
                            <div className="absolute top-10 left-0 right-0 text-center z-10 pointer-events-none">
                                <span className="text-6xl font-black text-white drop-shadow-[0_4px_4px_rgba(0,0,0,0.5)] stroke-black"
                                    style={{ textShadow: '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000' }}>
                                    {displayScore}
                                </span>
                            </div>
                        )}

                        <div className="flex justify-center bg-sky-200">
                            <canvas
                                ref={canvasRef}
                                width={CANVAS_WIDTH}
                                height={CANVAS_HEIGHT}
                                onClick={jump}
                                className="cursor-pointer"
                            />
                        </div>
                    </Card>

                    {/* Footer Info */}
                    <div className="flex justify-between items-center px-4 py-2 bg-slate-100 rounded-lg">
                        <div className="flex items-center gap-2">
                            <div className={`w-3 h-3 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
                            <span className="text-sm font-semibold text-slate-700">
                                {connected ? 'Wallet Connected' : 'Disconnected'}
                            </span>
                        </div>
                        <div className="font-mono text-xs text-slate-500">
                            {gamePubkey ? gamePubkey.toString().slice(0, 16) + '...' : 'No Game Account'}
                        </div>
                    </div>
                </div>

                {/* RIGHT COLUMN: COMMANDER */}
                <Card className={`col-span-3 flex flex-col h-full ${sessionToken ? 'border-orange-500 border-2 shadow-[0_0_20px_rgba(251,146,60,0.3)]' : 'border-slate-200'}`}>
                    <div className={`h-2 ${sessionToken ? 'bg-gradient-to-r from-orange-500 via-red-500 to-yellow-500 animate-gradient' : 'bg-slate-200'}`} />
                    <CardHeader>
                        <CardTitle className="flex justify-between items-center">
                            <span>Control Deck</span>
                            {sessionToken && <span className="text-xs bg-orange-100 text-orange-600 px-2 py-1 rounded-full border border-orange-200">🔥 TURBO</span>}
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1 flex flex-col gap-4">
                        {/* Input Section */}
                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-slate-500 uppercase">Input</label>
                            {!gameStarted ? (
                                <Button onClick={handleStartGame} disabled={isLoading} className="w-full bg-green-600 hover:bg-green-700 text-white h-12 text-lg">
                                    START GAME
                                </Button>
                            ) : gameOver ? (
                                <Button onClick={handleResetGame} disabled={isLoading} className="w-full bg-blue-600 hover:bg-blue-700 text-white h-12 text-lg">
                                    PLAY AGAIN
                                </Button>
                            ) : (
                                <Button onClick={jump} className="w-full h-24 text-xl font-black tracking-widest bg-slate-900 active:scale-95 transition-transform">
                                    FLAP (SPACE)
                                </Button>
                            )}
                        </div>

                        {/* Blockchain Config moved up */}
                        <div className="space-y-3 p-4 bg-slate-50 rounded-xl border border-slate-100">
                            <label className="text-xs font-semibold text-slate-500 uppercase block mb-2">Blockchain Config</label>

                            {delegationStatus !== "delegated" ? (
                                <Button onClick={() => handleAction(delegate, "Delegate")} disabled={isLoading} variant="outline" className="w-full border-black text-black hover:bg-black hover:text-white transition-colors">
                                    Step 1: Delegate to ER
                                </Button>
                            ) : (
                                <div className="space-y-2">
                                    <div className="text-center text-xs text-green-600 font-bold border border-green-200 bg-green-50 py-2 rounded">
                                        Ready to Play on ER
                                    </div>

                                    {!sessionToken && (
                                        <Button onClick={() => handleAction(async () => {
                                            await createSession();
                                            return "Session Created";
                                        }, "Create Session")} disabled={isSessionLoading} className="w-full bg-gradient-to-r from-orange-500 to-red-500 text-white border-0 shadow-lg hover:shadow-orange-500/50">
                                            Step 2: Activate Turbo
                                        </Button>
                                    )}

                                    {/* Advanced Options */}
                                    <div className="grid grid-cols-2 gap-2 mt-2">
                                        <Button onClick={() => handleAction(commit, "Commit")} disabled={isLoading} variant="outline" size="sm" className="text-xs border-slate-300">
                                            Commit Score
                                        </Button>
                                        <Button onClick={() => handleAction(undelegate, "Undelegate")} disabled={isLoading} variant="outline" size="sm" className="text-xs border-red-200 text-red-500 hover:bg-red-50">
                                            Undelegate
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Leaderboard Section (Fills remaining space) */}
                        <div className="flex-1 flex flex-col overflow-hidden">
                            <div className="text-xs font-semibold text-slate-500 uppercase mb-2 flex justify-between items-center">
                                <span>Leaderboard</span>
                                <span className="text-[10px] bg-slate-100 px-1 rounded">Base Layer High Scores</span>
                            </div>
                            <div className="bg-slate-50 rounded-lg p-3 flex-1 border border-slate-100 overflow-y-auto custom-scrollbar">
                                {leaderboard.map((item, i) => (
                                    <div key={i} className={`flex justify-between items-center text-xs py-2 border-b border-slate-200 last:border-0 ${item.name.includes(publicKey?.toString().slice(0, 5) || "") ? 'bg-orange-50 -mx-3 px-3 relative' : ''}`}>
                                        <div className="flex gap-2 items-center">
                                            {item.name.includes(publicKey?.toString().slice(0, 5) || "") && <div className="absolute left-0 top-0 bottom-0 w-1 bg-orange-400" />}
                                            {/* Rank Colors */}
                                            <span className={`w-4 text-center font-bold ${i === 0 ? 'text-yellow-600' :
                                                i === 1 ? 'text-slate-500' :
                                                    i === 2 ? 'text-orange-600' :
                                                        'text-slate-400'
                                                }`}>#{i + 1}</span>

                                            <span className={item.name.includes(publicKey?.toString().slice(0, 5) || "") ? 'font-bold text-gray-900' : 'text-gray-600'}>
                                                {item.name}
                                                {item.name.includes(publicKey?.toString().slice(0, 5) || "") && " (You)"}
                                            </span>
                                        </div>
                                        <span className="font-mono font-medium text-gray-700">{item.score}</span>
                                    </div>
                                ))}
                                {leaderboard.length === 0 && (
                                    <div className="text-center text-gray-400 text-xs py-4">
                                        No scores yet. Be the first!
                                    </div>
                                )}
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
