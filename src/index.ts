// Proof Gatekeeper agent — entrypoint.
// Startup order (fail fast): config -> artifacts -> prover self-test ->
// optional Kurier VK registration -> listen.
import { config } from "./config";
import { ensureCircuits } from "./artifacts";
import { Prover } from "./prover";
import { ProofStore } from "./store";
import { KurierClient } from "./kurier";
import { createServer } from "./server";
import { loadVkJson, type AgentContext } from "./handler";

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
