// Local Groth16 proving with snarkjs (wasm + zkey on disk).
// No network, no model: the proof is generated here and verified locally
// against the exported verification key before anything is returned.
import fs from "node:fs";
import path from "node:path";
import * as snarkjs from "snarkjs";
import type { CircuitInputs } from "./circuit";

export interface Groth16Proof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: string;
  curve: string;
}

export interface ProveResult {
  proof: Groth16Proof;
  publicSignals: string[];
}

export class Prover {
  private readonly wasmPath: string;
  private readonly zkeyPath: string;
  private readonly vkPath: string;
  private vk: Record<string, unknown> | null = null;

  constructor(circuitsDir: string) {
    this.wasmPath = path.join(circuitsDir, "gatekeeper.wasm");
    this.zkeyPath = path.join(circuitsDir, "gatekeeper_final.zkey");
    this.vkPath = path.join(circuitsDir, "gatekeeper.vk.json");
    for (const [label, p] of [
      ["wasm", this.wasmPath],
      ["zkey", this.zkeyPath],
      ["verification key", this.vkPath],
    ] as const) {
      if (!fs.existsSync(p)) {
        throw new Error(
          `Missing gatekeeper ${label} at ${p}. Download it from https://agentgames.zkverify.io/build (see README).`
        );
      }
    }
  }

  private loadVk(): Record<string, unknown> {
    if (!this.vk) {
      this.vk = JSON.parse(fs.readFileSync(this.vkPath, "utf8")) as Record<
        string,
        unknown
      >;
    }
    return this.vk;
  }

  /** Generate a Groth16 proof for the given circuit inputs. */
  async prove(input: CircuitInputs): Promise<ProveResult> {
    // snarkjs wants plain JSON values; BigInts are stringified by its
    // unstringifyBigInts handling when passed as strings — pass strings
    // explicitly to avoid any ambiguity.
    const jsonInput: Record<string, string> = {};
    for (const [k, v] of Object.entries(input)) {
      jsonInput[k] = typeof v === "bigint" ? v.toString() : String(v);
    }
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      jsonInput,
      this.wasmPath,
      this.zkeyPath
    );
    return { proof: proof as Groth16Proof, publicSignals: publicSignals as string[] };
  }

  /** Verify a proof locally against the exported verification key. */
  async verifyLocally(proof: Groth16Proof, publicSignals: string[]): Promise<boolean> {
    const vk = this.loadVk();
    return snarkjs.groth16.verify(vk, publicSignals, proof);
  }

  /**
   * Startup self-test: prove + verify a dummy all-pass input. If this
   * fails, the artifacts are broken and the process must not serve tasks.
   */
  async selfTest(): Promise<void> {
    const vkHash = BigInt(
      "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0"
    );
    const input: CircuitInputs = {
      minimum: 1000n,
      publicBalance: 1460n,
      expiryBlock: 8430000n,
      currentBlock: 8420000n,
      recipient: 3728908033n,
      conditionRecipient: 3728908033n,
      amount: 500n,
      maxTransfer: 1000n,
      taskId: 12345n,
      decision: 1,
      salt: 999n,
      registeredVkHash: vkHash,
      proofVkHash: vkHash,
    };
    const { proof, publicSignals } = await this.prove(input);
    const ok = await this.verifyLocally(proof, publicSignals);
    if (!ok) throw new Error("Prover self-test failed: proof did not verify locally.");
    if (publicSignals[11] !== "1") {
      throw new Error("Prover self-test failed: decision public signal is not 1.");
    }
  }
}
