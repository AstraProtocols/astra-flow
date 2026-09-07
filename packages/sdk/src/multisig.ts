import {
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { AstraFlowError, AuthExpiredError, TransactionFailedError, classifySendResult } from "./errors.js";
import { NETWORKS, type NetworkName } from "./types.js";

export interface CollectedSignature {
  publicKey: string;
  hint: string;
  signature: string;
}

export interface Signer {
  publicKey: string;
  sign(message: Buffer): Promise<Buffer> | Buffer;
}

function decoratedSignature(publicKey: string, signature: Buffer): xdr.DecoratedSignature {
  const hint = Keypair.fromPublicKey(publicKey).signatureHint();
  return new xdr.DecoratedSignature({ hint, signature });
}

function signatureHintHex(publicKey: string): string {
  return Buffer.from(Keypair.fromPublicKey(publicKey).signatureHint()).toString("hex");
}

/**
 * Collects signatures for a pre-assembled transaction, either sequentially or
 * in parallel, then submits the fully signed envelope to Soroban RPC.
 */
export class SignatureAggregator {
  private tx: Transaction;
  readonly signatures: CollectedSignature[] = [];

  constructor(txXdr: string, networkPassphrase: string) {
    this.tx = new Transaction(txXdr, networkPassphrase);
  }

  static fromXdr(txXdr: string, network: NetworkName | string): SignatureAggregator {
    const passphrase =
      network === "testnet" || network === "mainnet"
        ? NETWORKS[network].networkPassphrase
        : network;
    return new SignatureAggregator(txXdr, passphrase);
  }

  hash(): Buffer {
    return this.tx.hash();
  }

  envelopeXdr(): string {
    return this.tx.toXDR();
  }

  has(publicKey: string): boolean {
    return this.signatures.some((item) => item.publicKey === publicKey);
  }

  addSignature(publicKey: string, signature: Buffer | string): this {
    const bytes = typeof signature === "string" ? Buffer.from(signature, "base64") : signature;
    if (bytes.length !== 64) {
      throw new AstraFlowError("Ed25519 signatures must be 64 bytes", { code: "BAD_SIGNATURE" });
    }
    if (this.has(publicKey)) {
      return this;
    }
    const kp = Keypair.fromPublicKey(publicKey);
    if (!kp.verify(this.hash(), bytes)) {
      throw new AstraFlowError(`Signature does not verify for ${publicKey}`, {
        code: "BAD_SIGNATURE",
      });
    }
    this.tx.signatures.push(decoratedSignature(publicKey, bytes));
    this.signatures.push({
      publicKey,
      hint: signatureHintHex(publicKey),
      signature: bytes.toString("base64"),
    });
    return this;
  }

  async signSequential(signers: Signer[]): Promise<this> {
    for (const signer of signers) {
      const signature = await signer.sign(this.hash());
      this.addSignature(signer.publicKey, Buffer.from(signature));
    }
    return this;
  }

  async signParallel(signers: Signer[]): Promise<this> {
    const payload = this.hash();
    const signed = await Promise.all(
      signers.map(async (signer) => ({
        publicKey: signer.publicKey,
        signature: Buffer.from(await signer.sign(payload)),
      })),
    );
    for (const item of signed) {
      this.addSignature(item.publicKey, item.signature);
    }
    return this;
  }

  requiredThreshold(sourceWeight = 1, threshold = 1): boolean {
    return this.signatures.length * sourceWeight >= threshold;
  }

  async submit(rpcUrl: string): Promise<string> {
    if (this.signatures.length === 0 && this.tx.signatures.length === 0) {
      throw new AstraFlowError("Cannot submit an unsigned transaction", { code: "MISSING_SIGNATURE" });
    }
    const server = new rpc.Server(rpcUrl, { allowHttp: false });
    try {
      const sent = await server.sendTransaction(this.tx);
      classifySendResult(sent);
      if (!sent.hash) {
        throw new TransactionFailedError("RPC accepted the transaction without a hash", {
          cause: sent,
        });
      }
      return sent.hash;
    } catch (error) {
      if (error instanceof AstraFlowError) throw error;
      throw new AuthExpiredError("Failed to submit multi-sig envelope", { cause: error });
    }
  }
}

export function cloneTransaction(txXdr: string, networkPassphrase: string): string {
  const tx = TransactionBuilder.fromXDR(txXdr, networkPassphrase);
  return tx.toXDR();
}

export function transactionHashHex(txXdr: string, networkPassphrase: string): string {
  return new Transaction(txXdr, networkPassphrase).hash().toString("hex");
}
