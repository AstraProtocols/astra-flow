"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  isConnected,
  requestAccess,
  getAddress,
  getNetwork,
  getNetworkDetails,
} from "@stellar/freighter-api";
import { NETWORKS, type NetworkName } from "@astraprotocols/sdk";

export type WalletConnector = "freighter" | "xbull";

interface XBullProvider {
  connect(opts?: { canRequestPublicKey?: boolean }): Promise<{ publicKey?: string; address?: string } | string>;
  disconnect?(): Promise<void> | void;
  getPublicKey?(): Promise<string>;
  getNetwork?(): Promise<string>;
}

declare global {
  interface Window {
    xBull?: XBullProvider;
    xBullSDK?: XBullProvider;
  }
}

interface PersistedWallet {
  connector: WalletConnector;
  publicKey: string;
  network: NetworkName;
}

interface WalletContextValue {
  publicKey: string | null;
  network: NetworkName;
  networkPassphrase: string;
  connector: WalletConnector | null;
  connecting: boolean;
  reconnecting: boolean;
  error: string | null;
  networkMismatch: boolean;
  connect: (connector: WalletConnector) => Promise<void>;
  disconnect: () => Promise<void>;
  setNetwork: (network: NetworkName) => Promise<void>;
  refresh: () => Promise<void>;
}

const STORAGE_KEY = "astra-flow.wallet";
const WalletContext = createContext<WalletContextValue | undefined>(undefined);

function readPersisted(): PersistedWallet | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedWallet;
    if (!parsed.connector || !parsed.publicKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persist(value: PersistedWallet | null): void {
  if (typeof window === "undefined") return;
  if (!value) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

function mapFreighterNetwork(value: string | undefined): NetworkName | null {
  if (!value) return null;
  const normalized = value.toUpperCase();
  if (normalized.includes("PUBLIC") || normalized === "MAINNET") return "mainnet";
  if (normalized.includes("TEST") || normalized === "TESTNET") return "testnet";
  return null;
}

async function detectFreighterNetwork(): Promise<NetworkName | null> {
  try {
    const details = await getNetworkDetails();
    if (details && typeof details === "object") {
      const fromDetails =
        mapFreighterNetwork(
          "networkPassphrase" in details ? String(details.networkPassphrase) : undefined,
        ) ?? mapFreighterNetwork("network" in details ? String(details.network) : undefined);
      if (fromDetails) return fromDetails;
    }
  } catch {
    // Older Freighter builds only expose getNetwork().
  }
  try {
    const network = await getNetwork();
    if (typeof network === "string") return mapFreighterNetwork(network);
    if (network && typeof network === "object" && "network" in network) {
      return mapFreighterNetwork(String(network.network));
    }
  } catch {
    return null;
  }
  return null;
}

async function connectFreighter(): Promise<{ publicKey: string; network: NetworkName | null }> {
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
    typeof addressResult === "string" ? addressResult : addressResult?.address;
  if (!address) {
    throw new Error("Freighter did not return a public key.");
  }
  return { publicKey: address, network: await detectFreighterNetwork() };
}

function xbullProvider(): XBullProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return window.xBull ?? window.xBullSDK;
}

async function connectXBull(): Promise<{ publicKey: string; network: NetworkName | null }> {
  const provider = xbullProvider();
  if (!provider?.connect) {
    throw new Error("xBull wallet was not detected in this browser.");
  }
  const result = await provider.connect({ canRequestPublicKey: true });
  const publicKey =
    typeof result === "string" ? result : (result.publicKey ?? result.address);
  if (!publicKey) {
    throw new Error("xBull did not return a public key.");
  }
  let network: NetworkName | null = null;
  if (provider.getNetwork) {
    network = mapFreighterNetwork(await provider.getNetwork());
  }
  return { publicKey, network };
}

async function silentFreighter(expected?: string): Promise<string | null> {
  try {
    const connected = await isConnected();
    const available =
      typeof connected === "object" && connected !== null && "isConnected" in connected
        ? Boolean(connected.isConnected)
        : Boolean(connected);
    if (!available) return null;
    const addressResult = await getAddress();
    const address =
      typeof addressResult === "string" ? addressResult : addressResult?.address;
    if (!address) return null;
    if (expected && address !== expected) return address;
    return address;
  } catch {
    return null;
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [network, setNetworkState] = useState<NetworkName>("testnet");
  const [walletNetwork, setWalletNetwork] = useState<NetworkName | null>(null);
  const [connector, setConnector] = useState<WalletConnector | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reconnectAttempted = useRef(false);

  const applySession = useCallback(
    (next: { connector: WalletConnector; publicKey: string; network: NetworkName; walletNetwork: NetworkName | null }) => {
      setPublicKey(next.publicKey);
      setConnector(next.connector);
      setNetworkState(next.network);
      setWalletNetwork(next.walletNetwork);
      persist({
        connector: next.connector,
        publicKey: next.publicKey,
        network: next.network,
      });
    },
    [],
  );

  const connect = useCallback(
    async (next: WalletConnector) => {
      setConnecting(true);
      setError(null);
      try {
        const result = next === "freighter" ? await connectFreighter() : await connectXBull();
        applySession({
          connector: next,
          publicKey: result.publicKey,
          network: result.network ?? network,
          walletNetwork: result.network,
        });
      } catch (cause) {
        setPublicKey(null);
        setConnector(null);
        persist(null);
        setError(cause instanceof Error ? cause.message : "Wallet connection failed.");
      } finally {
        setConnecting(false);
      }
    },
    [applySession, network],
  );

  const disconnect = useCallback(async () => {
    try {
      if (connector === "xbull") {
        await xbullProvider()?.disconnect?.();
      }
    } catch {
      // Wallet disconnect is best-effort; local session is cleared regardless.
    }
    setPublicKey(null);
    setConnector(null);
    setWalletNetwork(null);
    setError(null);
    persist(null);
  }, [connector]);

  const setNetwork = useCallback(async (next: NetworkName) => {
    setNetworkState(next);
    const current = readPersisted();
    if (current) {
      persist({ ...current, network: next });
    }
    if (connector === "freighter") {
      const detected = await detectFreighterNetwork();
      setWalletNetwork(detected);
      if (detected && detected !== next) {
        setError(`Freighter is on ${detected}. Switch the extension network to ${next}.`);
      } else {
        setError(null);
      }
    }
  }, [connector]);

  const refresh = useCallback(async () => {
    if (connector === "freighter" && publicKey) {
      const address = await silentFreighter();
      if (address && address !== publicKey) {
        applySession({
          connector: "freighter",
          publicKey: address,
          network,
          walletNetwork: await detectFreighterNetwork(),
        });
      }
      const detected = await detectFreighterNetwork();
      setWalletNetwork(detected);
    }
  }, [applySession, connector, network, publicKey]);

  useEffect(() => {
    if (reconnectAttempted.current) return;
    reconnectAttempted.current = true;
    const saved = readPersisted();
    void (async () => {
      try {
        if (!saved) return;
        setNetworkState(saved.network);
        if (saved.connector === "freighter") {
          const address = await silentFreighter(saved.publicKey);
          if (!address) return;
          const detected = await detectFreighterNetwork();
          applySession({
            connector: "freighter",
            publicKey: address,
            network: saved.network,
            walletNetwork: detected,
          });
          return;
        }
        const provider = xbullProvider();
        if (!provider) return;
        const address = provider.getPublicKey ? await provider.getPublicKey() : saved.publicKey;
        if (address) {
          applySession({
            connector: "xbull",
            publicKey: address,
            network: saved.network,
            walletNetwork: provider.getNetwork
              ? mapFreighterNetwork(await provider.getNetwork())
              : saved.network,
          });
        }
      } catch {
        persist(null);
      } finally {
        setReconnecting(false);
      }
    })();
    if (!saved) setReconnecting(false);
  }, [applySession]);

  useEffect(() => {
    if (!publicKey || connector !== "freighter") return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 8_000);
    return () => window.clearInterval(timer);
  }, [connector, publicKey, refresh]);

  const networkMismatch = Boolean(walletNetwork && walletNetwork !== network);

  const value = useMemo(
    () => ({
      publicKey,
      network,
      networkPassphrase: NETWORKS[network].networkPassphrase,
      connector,
      connecting,
      reconnecting,
      error,
      networkMismatch,
      connect,
      disconnect,
      setNetwork,
      refresh,
    }),
    [
      publicKey,
      network,
      connector,
      connecting,
      reconnecting,
      error,
      networkMismatch,
      connect,
      disconnect,
      setNetwork,
      refresh,
    ],
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

export function useWalletPublicKey(): string | null {
  return useWallet().publicKey;
}

export function useWalletNetwork(): NetworkName {
  return useWallet().network;
}
