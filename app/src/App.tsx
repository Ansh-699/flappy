import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { FlappyBird } from "./components/FlappyBird";
import "./index.css";

export function App() {
  return (
    <>
      <div className="absolute top-5 right-5 flex gap-2 items-center z-50">
        <WalletMultiButton />
      </div>
      <div className="bg-gray-50 min-h-screen">
        <div className="max-w-7xl mx-auto ">
          <header className="text-center mb-4">
            <h1 className="text-2xl font-bold mb-1">
              {/* On-Chain Flappy Bird */}
            </h1>
            <p className="text-gray-500 text-sm">
              {/* Fully on-chain game powered by MagicBlock Ephemeral Rollups */}
            </p>
          </header>

          <main className="flex justify-center">
            <FlappyBird />
          </main>

          <footer className="text-center mt-4 text-gray-500 text-sm">
            <p>MagicBlock + Anchor + Solana • 10ms Latency</p>
          </footer>
        </div>
      </div>
    </>
  );
}

export default App;
