"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  isConnected,
  requestAccess,
  getAddress,
  getNetwork,
} from "@stellar/freighter-api";
import type { NetworkName } from "@astraprotocols/sdk";

export type WalletConnector = "freighter" | "xbull";

interface XBullProvider {
  connect(): Promise<{ publicKey?: string; address?: string } | string>;
}

declare global {
  interface Window {
    xBull?: XBullProvider;
    xBullSDK?: XBullProvider;
  }
}

interface WalletContextValue {
  publicKey: string | null;
  network: NetworkName;
  connector: WalletConnector | null;
  connecting: boolean;
  error: string | null;
  connect: (connector: WalletConnector) => Promise<void>;
  disconnect: () => void;
  setNetwork: (network: NetworkName) => void;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

async function connectFreighter(): Promise<string> {
  const connected = await isConnected();
  if (connected && typeof connected === "object" && "isConnected" in connected && !connected.isConnected) {
    throw new Error("Freighter is not available. Install the Freighter browser extension.");
  }

  const access = await requestAccess();
  if (access && typeof access === "object" && "error" in access && access.error) {
    throw new Error(String(access.error));
  }

  const addressResult = await getAddress();
  const address =
    typeof addressResult === "string"
      ? addressResult
      : addressResult?.address;
  if (!address) {
    throw new Error("Freighter did not return a public key.");
  }

  const networkResult = await getNetwork();
  if (networkResult && typeof networkResult === "object" && "network" in networkResult) {
    return address;
  }
  return address;
}

async function connectXBull(): Promise<string> {
  const provider = window.xBull ?? window.xBullSDK;
  if (!provider?.connect) {
    throw new Error("xBull wallet was not detected in this browser.");
  }
  const result = await provider.connect();
  if (typeof result === "string") return result;
  const publicKey = result.publicKey ?? result.address;
  if (!publicKey) {
    throw new Error("xBull did not return a public key.");
  }
  return publicKey;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [network, setNetwork] = useState<NetworkName>("testnet");
  const [connector, setConnector] = useState<WalletConnector | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async (next: WalletConnector) => {
    setConnecting(true);
    setError(null);
    try {
      const key = next === "freighter" ? await connectFreighter() : await connectXBull();
      setPublicKey(key);
      setConnector(next);
    } catch (cause) {
      setPublicKey(null);
      setConnector(null);
      setError(cause instanceof Error ? cause.message : "Wallet connection failed.");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setPublicKey(null);
    setConnector(null);
    setError(null);
  }, []);

  const value = useMemo(
    () => ({
      publicKey,
      network,
      connector,
      connecting,
      error,
      connect,
      disconnect,
      setNetwork,
    }),
    [publicKey, network, connector, connecting, error, connect, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error("useWallet must be used within WalletProvider");
  }
  return context;
}
