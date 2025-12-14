import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { FlappyBird } from "../target/types/flappy_bird";

const GAME_SEED = Buffer.from("game_v2");

describe("Flappy Bird - Base Layer", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.FlappyBird as Program<FlappyBird>;
  const wallet = provider.wallet as anchor.Wallet;

  const [gamePda] = PublicKey.findProgramAddressSync(
    [GAME_SEED, wallet.publicKey.toBuffer()],
    program.programId
  );

  it("initializes (idempotent) and sets defaults", async () => {
    await program.methods
      .initialize()
      .accounts({
        authority: wallet.publicKey,
      } as any)
      .rpc();

    const game = await program.account.gameState.fetch(gamePda);
    expect(game.authority.toBase58()).to.equal(wallet.publicKey.toBase58());
    expect(game.score.toNumber()).to.equal(0);
    expect(game.highScore.toNumber()).to.equal(0);
    expect(game.gameStatus).to.have.property("notStarted");
    expect(game.birdVelocity).to.equal(0);
  });

  it("startGame transitions to playing and resets state", async () => {
    await program.methods
      .startGame()
      .accounts({
        game: gamePda,
        signer: wallet.publicKey,
        sessionToken: null,
      } as any)
      .rpc();

    const game = await program.account.gameState.fetch(gamePda);
    expect(game.gameStatus).to.have.property("playing");
    expect(game.score.toNumber()).to.equal(0);
    expect(game.birdVelocity).to.equal(0);
  });

  it("tick advances frameCount and updates bird position", async () => {
    const before = await program.account.gameState.fetch(gamePda);

    await program.methods
      .tick()
      .accounts({
        game: gamePda,
        signer: wallet.publicKey,
        sessionToken: null,
      } as any)
      .rpc();

    const after = await program.account.gameState.fetch(gamePda);
    expect(after.frameCount.toNumber()).to.equal(before.frameCount.toNumber() + 1);
    expect(after.birdY).to.not.equal(before.birdY);
  });

  it("flap sets upward velocity (negative) and advances one tick", async () => {
    await program.methods
      .flap()
      .accounts({
        game: gamePda,
        signer: wallet.publicKey,
        sessionToken: null,
      } as any)
      .rpc();

    const game = await program.account.gameState.fetch(gamePda);
    expect(game.birdVelocity).to.be.lessThan(0);
    expect(game.frameCount.toNumber()).to.be.greaterThan(0);
  });

  it("startGame fails when already playing", async () => {
    try {
      await program.methods
        .startGame()
        .accounts({
          game: gamePda,
          signer: wallet.publicKey,
          sessionToken: null,
        } as any)
        .rpc();
      expect.fail("expected startGame to fail when already playing");
    } catch (e) {
      const msg = String(e);
      expect(msg).to.match(/GameAlreadyStarted|already started/i);
    }
  });

  it("invalid signer cannot control the game", async () => {
    const bad = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(bad.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig, "confirmed");

    const badProvider = new anchor.AnchorProvider(
      provider.connection,
      new anchor.Wallet(bad),
      provider.opts
    );
    const badProgram = new Program<FlappyBird>(program.idl as any, badProvider);

    try {
      await badProgram.methods
        .tick()
        .accounts({
          game: gamePda,
          signer: bad.publicKey,
          sessionToken: null,
        } as any)
        .rpc();
      expect.fail("expected InvalidAuth");
    } catch (e) {
      const msg = String(e);
      expect(msg).to.match(/InvalidAuth|Invalid authentication/i);
    }
  });

  it("resetGame returns to notStarted; tick then fails", async () => {
    await program.methods
      .resetGame()
      .accounts({
        game: gamePda,
        signer: wallet.publicKey,
        sessionToken: null,
      } as any)
      .rpc();

    const game = await program.account.gameState.fetch(gamePda);
    expect(game.gameStatus).to.have.property("notStarted");

    try {
      await program.methods
        .tick()
        .accounts({
          game: gamePda,
          signer: wallet.publicKey,
          sessionToken: null,
        } as any)
        .rpc();
      expect.fail("expected GameNotPlaying");
    } catch (e) {
      const msg = String(e);
      expect(msg).to.match(/GameNotPlaying|not in playing/i);
    }
  });
});
