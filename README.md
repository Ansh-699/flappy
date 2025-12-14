# Flappy Bird on Solana with Ephemeral Rollups

This project is a fully on-chain Flappy Bird game built with Solana, Anchor, and MagicBlock Ephemeral Rollups (ER). All game logic (physics, pipes, collision, scoring) runs on-chain, and the frontend interacts with the program via ER for low-latency gameplay.

## Features
- 100% on-chain game logic (no client-side prediction)
- Fast, low-latency state updates using MagicBlock ER
- Session wallet support (no wallet popups after session creation)
- Modern React frontend (Bun runtime)

## How to Run Locally

### Prerequisites
- [Node.js](https://nodejs.org/) or [Bun](https://bun.sh/) (recommended)
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools)
- [Anchor](https://book.anchor-lang.com/chapter_2/installation.html)
- [Rust](https://rustup.rs/)

### 1. Clone the repo
```sh
git clone https://github.com/Ansh-699/flappy.git
cd flappy
```

### 2. Install dependencies
```sh
cd app
bun install  # or npm install
```

### 3. Build and deploy the program (devnet)
```sh
cd ..
anchor build -p flappy_bird
anchor deploy -p flappy_bird --provider.cluster devnet
```

### 4. Copy the IDL to the frontend
```sh
cp target/idl/flappy_bird.json app/src/idl/flappy_bird.json
```

### 5. Run the frontend
```sh
cd app
bun run dev  # or npm run dev
```

Visit [http://localhost:3002](http://localhost:3002) to play!

## Notes
- Make sure to create a session wallet in the UI before playing (no popups after that)
- All gameplay is on-chain; network latency may cause some jitter
- For best results, use the MagicBlock ER devnet validator

---

Made with ❤️ on Solana + MagicBlock