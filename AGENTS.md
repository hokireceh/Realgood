# AGENTS.md — proof-gatekeeper

Minimal working notes for this project (Agent Games — Proof Gatekeeper agent,
TypeScript, Node.js). Created 2026-11-16 during the Steal-the-VFY execution
phase; the project previously had no AGENTS.md.

## Stack & commands

- TypeScript (CommonJS output, `tsc` → `dist/`). No framework, plain HTTP.
- `npm install` · `npm run build` (tsc) · `npm test` (build + `tsx test/harness.ts`,
  end-to-end replay harness — must stay 133 checks, 0 failures) ·
  `npm start` (`node dist/index.js`) · `npm run dev` (`tsx src/index.ts`) ·
  `npm run fetch-circuits` (download circuit binaries explicitly).
- Runtime deps only: `dotenv`, `ethers`, `snarkjs`, `circomlibjs` (Poseidon
  is used at runtime by the Steal track). Dev: `@types/node`, `tsx`,
  `typescript`.

## Conventions (locked)

- **Fail closed.** On any timeout, error, or uncertainty the agent REJECTs —
  never approve by default. No model makes the final call.
- **Circuit artifacts are fetched, never committed.** `circuits/*.wasm` and
  `circuits/*_final.zkey` are gitignored; `src/artifacts.ts` downloads them
  from `agentgames.zkverify.io/circuits` at startup and verifies SHA-256.
  Only `*.vk.json` is committed.
- **Secrets live only in env.** `.env` (mode 600) and `data/` are gitignored.
  Never print, commit, or paste a secret, API key, or session token. The
  HMAC secret comes from the dashboard Rotate Secret (shown once).
- **No breaking changes to the live Gatekeeper path.** `POST /agent` +
  `GET /health` behaviour, the decision checklist order, and the strict
  Kurier-Finalized mode stay as-is unless the user explicitly approves a
  change. New tracks go on separate routes/files.
- **Verify before reporting.** Worker/cron claims are re-checked against
  `state/*` and on-chain data; BigInt math via script, never by hand.
- **Endpoint source of truth:** `docs/endpoints.md` — every endpoint there
  carries method, URL, headers, example payload/response, and confidence
  (terverifikasi / belum). Undocumented endpoints are only used in code
  after real request/response proof; unverified ones are marked and never
  used in production paths.
- **Protocol assumptions are isolated.** `taskId` encoding lives only in
  `src/circuit.ts → encodeTaskId`; HMAC algorithm only in `HMAC_ALGORITHM`
  env. If the platform documents something different, change only that spot.
- **Tests are the contract.** `test/harness.ts` replays real task samples
  and checks every public signal + local proof verification. New tracks get
  their own harness file; never weaken the existing one.
- **Deploy:** Fly.io app `realgood` (iad, 2 machines, 256 MB). The VM
  cannot use Fly builders (outbound UDP blocked) — deploy with
  `fly deploy --image <image-in-registry>` only. Never retry a builder
  path from this VM.
