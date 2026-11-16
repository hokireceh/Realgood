// Proof Gatekeeper agent — entrypoint.
// Startup order (fail fast): config -> artifacts -> prover self-test ->
// optional Kurier VK registration -> listen.
import { config } from "./config";
import { ensureCircuits } from "./artifacts";
import { Prover, STEAL_ARTIFACTS } from "./prover";
import { ProofStore } from "./store";
import { KurierClient } from "./kurier";
import { createServer } from "./server";
import { loadVkJson, type AgentContext } from "./handler";
import { parseStrategyParams } from "./policy";
import {
  buildStealCircuitInput,
  computeCommitment,
  encodeMatchId,
  parseSalt,
  STEAL_ACTION_CODE,
  STEAL_CIRCUIT_VERSION,
} from "./steal-circuit";
import type { StealContext } from "./steal-handler";

async function main(): Promise<void> {
  console.log("[gatekeeper] starting…");

  // Binary circuit artifacts are fetched (not committed) — download any
  // missing/mismatched file from the platform and verify its SHA-256.
  await ensureCircuits(config.circuitsDir);

  const prover = new Prover(config.circuitsDir);
  const store = new ProofStore(config.dataDir);
  console.log(`[gatekeeper] proof store: ${store.count} prior record(s) loaded`);

  if (!config.skipSelfTest) {
    const t0 = Date.now();
    await prover.selfTest();
    console.log(`[gatekeeper] prover self-test passed (${Date.now() - t0}ms)`);
  } else {
    console.warn("[gatekeeper] SKIP_SELF_TEST=1 — prover self-test skipped");
  }

  const vkJson = loadVkJson(config.circuitsDir);

  // Steal-the-VFY: optional track. When STEAL_VFY_SALT is set, the
  // strategy is validated, the commitment is computed, and a second
  // prover (vfy-policy artifacts) runs its own self-test. The commitment
  // hex printed here is what gets registered in the dashboard — changing
  // params or salt afterwards requires re-registration.
  let steal: StealContext | null = null;
  if (config.stealSalt !== null) {
    const params = parseStrategyParams(config.stealParamsRaw);
    const salt = parseSalt(config.stealSalt);
    const commitment = await computeCommitment(params, salt);
    const stealProver = new Prover(config.circuitsDir, STEAL_ARTIFACTS);
    if (!config.skipSelfTest) {
      const t0 = Date.now();
      const selfTestInput = buildStealCircuitInput({
        commitment: BigInt(commitment.decimal),
        matchId: encodeMatchId("00000000-0000-0000-0000-000000000001"),
        turnNumber: 1n,
        selfBalance: 100n,
        opponentBalance: 100n,
        action: STEAL_ACTION_CODE.EXTRACT,
        amount: params[0],
        circuitVersion: STEAL_CIRCUIT_VERSION,
        salt,
        strategyParams: params,
      });
      await stealProver.selfTest(selfTestInput, (signals) => {
        if (signals[6] !== "2" || signals[8] !== "1") {
          throw new Error(
            "vfy-policy self-test failed: expected an EXTRACT proof (action 2, circuitVersion 1)."
          );
        }
      });
      console.log(`[steal] prover self-test passed (${Date.now() - t0}ms)`);
    } else {
      console.warn("[steal] SKIP_SELF_TEST=1 — vfy-policy self-test skipped");
    }
    console.log(`[steal] strategy commitment (register in dashboard): ${commitment.hex}`);
    console.log(`[steal] params: ${params.join(",")} — changing them requires a new commitment + re-registration`);
    steal = {
      params,
      salt,
      commitmentHex: commitment.hex,
      commitmentDecimal: commitment.decimal,
      prover: stealProver,
    };
  } else {
    console.warn(
      "[steal] STEAL_VFY_SALT is not set — Steal-the-VFY turns will return 503. " +
        "Set STEAL_VFY_SALT (+ optionally STEAL_VFY_PARAMS) to enable the track."
    );
  }

  let kurier: KurierClient | null = null;
  let kurierVkHash = config.gatekeeperVkHash;
  if (config.kurierApiKey !== null) {
    kurier = new KurierClient(config.kurierApiUrl, config.kurierApiKey);
    if (!config.kurierVkRegistered) {
      console.log("[gatekeeper] registering verification key with Kurier…");
      kurierVkHash = await kurier.registerVk(vkJson);
      console.log(`[gatekeeper] Kurier vkHash: ${kurierVkHash}`);
    } else {
      console.log(`[gatekeeper] Kurier enabled (vk already registered): ${kurierVkHash}`);
    }
  } else {
    console.warn("[gatekeeper] Kurier disabled — proofs are local-only");
  }

  const ctx: AgentContext = {
    config,
    prover,
    store,
    kurier,
    kurierVkHash,
    vkJson,
    steal,
    stealResponses: new Map(),
  };

  const server = createServer(ctx);
  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, () => resolve());
  });
  const scheme = config.tlsKeyPath ? "https" : "http";
  console.log(
    `[gatekeeper] listening on ${scheme}://${config.host}:${config.port} ` +
      `(POST /agent, GET /health) — strict finalized mode: ${config.requireKurierFinalized}`
  );

  const shutdown = () => {
    console.log("[gatekeeper] shutting down…");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[gatekeeper] fatal startup error:", (err as Error).message);
  process.exit(1);
});
