# Proof Gatekeeper — zkVerify Agent Games

A production-ready agent endpoint for the **Proof Gatekeeper** track of the
[zkVerify Agent Games](https://agentgames.zkverify.io/build). The platform
POSTs signed transfer tasks to a public HTTPS endpoint; this agent decides
**APPROVE** or **REJECT** with deterministic code, generates a Groth16 proof
locally with `snarkjs`, submits it to zkVerify via **Kurier**, and returns a
signed response. The circuit is the referee: the platform re-verifies the
proof against its own verification key and scores the decision independently.

> **Fail closed.** On any timeout, error, or uncertainty the agent REJECTs —
> it never approves by default. No language model makes the final call.

## File structure

```
proof-gatekeeper/
├── package.json            # scripts: build / start / dev / test
├── tsconfig.json
├── .env.example            # blank config (copy to .env; .env is gitignored)
├── .gitignore
├── circuits/
│   ├── gatekeeper.vk.json          # verification key, exported from the zkey
│   └── vfy-policy.vk.json          # vk exported from the zkey (9 public signals)
│   # *.wasm / *_final.zkey are NOT committed — fetched at startup from
│   # agentgames.zkverify.io/circuits and verified by SHA-256 (src/artifacts.ts).
│   # Run `npm run fetch-circuits` to download them explicitly.
├── src/
│   ├── index.ts            # entrypoint: config → artifacts → self-test → listen
│   ├── config.ts           # env loading + validation (fails fast, no secrets in code)
│   ├── server.ts           # HTTP(S) server, POST /agent + GET /health, raw-body capture
│   ├── handler.ts          # orchestration: HMAC → checks → prove → Kurier → sign
│   ├── hmac.ts             # HMAC-SHA256 sign/verify (timing-safe, raw body)
│   ├── decision.ts         # envelope parsing + deterministic checklist + circuit verdict
│   ├── circuit.ts          # circuit facts, field encodings, public-signal layout
│   ├── prover.ts           # snarkjs fullProve + local verify + startup self-test
│   ├── kurier.ts           # Kurier REST: register-vk, submit-proof, poll job-status
│   └── store.ts            # durable proof log (replay protection + dispute evidence)
├── test/
│   ├── harness.ts          # end-to-end replay harness (see below)
│   └── samples/            # 7 task envelopes + 1 preflight request
└── data/                   # runtime proof log (gitignored; created at runtime)
```

## The circuit — verified facts (not assumed)

The gatekeeper circuit was reverse-engineered empirically from the shipped
artifacts (FNV signal-name probing of the wasm + witness experiments), and
every claim below is covered by `test/harness.ts`:

- **Groth16 / BN128, Circom 2.x.** Registered vk hash (zkVerify mainnet):
  `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
- **13 inputs:** `minimum, publicBalance, expiryBlock, currentBlock,
  recipient, conditionRecipient, amount, maxTransfer, taskId, decision,
  salt, registeredVkHash, proofVkHash`. Only `salt` is private.
- **13 public signals, in order:**
  `[binding, registeredVkHash, proofVkHash, minimum, publicBalance,
  expiryBlock, currentBlock, recipient, conditionRecipient, amount,
  maxTransfer, decision, taskId]`
  - `binding` (signal 0) = **Poseidon(salt, taskId)** — the proof reference.
    A reused binding is a replay.
  - `decision` (signal 11) is `1` for APPROVE, `0` for REJECT.
  - Hashes and addresses are field elements (hashes reduced mod the BN128
    scalar field, exactly as snarkjs normalises them).
- **The decisive rule:** the circuit constrains
  `decision == (publicBalance >= minimum && recipient == conditionRecipient
  && amount <= maxTransfer && currentBlock <= expiryBlock
  && proofVkHash == registeredVkHash)`.
  A valid proof exists **only for the correct decision** — the agent cannot
  approve a trap, and it cannot reject a valid request, and still produce a
  valid proof. Non-circuit rejections (VK substitution, stale timestamp,
  replay, Kurier not finalized) therefore carry **no proof** — exactly like
  the platform's own example response for `VK_SUBSTITUTION`, which omits
  `proof` and `public_signals`.
- **Performance on this box:** `fullProve` ≈ 1 s, local `verify` ≈ 0.1 s —
  comfortably inside the 60 s response deadline.

> **Second circuit on the platform — not used here.** The platform serves a
> second circuit, `vfy-policy` (vk hash
> `0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047`,
> 9 public signals), for the **Steal the VFY** track: each turn the agent
> returns a *policy proof* for its action. This service is Proof Gatekeeper
> only and never loads it; its artifacts are fetched on demand by
> `src/artifacts.ts` (pinned SHA-256) in case a Steal-the-VFY agent is
> built later — only its `vk.json` is committed.

## Decision checklist (deterministic, in order)

1. `registered_vk` equals the registered vk hash → else `VK_SUBSTITUTION`
2. `proof_vk` equals `registered_vk` → else `VK_MISMATCH`
3. `task_id` never answered before → else `TASK_REPLAY`
4. `issued_at` fresh (±5 min) and `deadline_at` not passed → else
   `TIMESTAMP_INVALID` / `TASK_EXPIRED`
5. `public_balance >= minimum` → else `BELOW_MINIMUM`
6. `recipient == condition_recipient` → else `RECIPIENT_MISMATCH`
7. `amount <= max_transfer` → else `AMOUNT_EXCEEDS_MAX`
8. `current_block <= expiry_block` → else `EXPIRED`

All pass → `APPROVE` (`reason_code: "OK"`). The proof is then generated
for that decision, verified locally, submitted to Kurier, and the agent
waits for **Finalized** (strict mode, see below) before responding.

## Request / response

**Task envelope** (`POST /agent`, `type: "agent-games.proof-gatekeeper.v1"`):

```json
{
  "type": "agent-games.proof-gatekeeper.v1",
  "task_id": "gk_8d31_...",
  "mode": "competition",
  "issued_at": "<issued-at>",
  "deadline_at": "<deadline-at>",
  "input": {
    "registered_vk": "0x7d...91", "proof_vk": "0x13...aa",
    "minimum": "1000", "public_balance": "1460",
    "expiry_block": 8430000, "current_block": 8420000,
    "recipient": "0xDe42...9f01", "condition_recipient": "0xDe42...9f01",
    "amount": "500", "max_transfer": "1000",
    "proof_tx": "0xa8...2c"
  }
}
```

**Response** (always HTTP 200 for a task, signed with
`x-agent-games-signature` over the raw body):

```json
{
  "decision": "APPROVE",
  "reason_code": "OK",
  "proof": { "pi_a": ["...", "...", "1"], "pi_b": [[...], [...], ["1", "0"]], "pi_c": ["...", "...", "1"], "protocol": "groth16", "curve": "bn128" },
  "public_signals": ["...", "...", "..."],
  "proof_tx": "0x... (Kurier tx hash when finalized, else null)"
}
```

**Preflight** (`type: "agent-games.preflight.v1"`) → `{ "ok": true,
"protocolVersion": "v1" }`, signed. Preflight must pass before the platform
marks the agent active.

**Auth:** every inbound request is HMAC-verified over the **raw body**
before parsing (`x-agent-games-signature`, HMAC-SHA256 hex, timing-safe
compare). Mismatch → `401`, no further processing. Every response is signed
the same way.

## Setup

```bash
npm install
cp .env.example .env        # fill in AGENT_GAMES_HMAC_SECRET + KURIER_API_KEY
npm run build               # tsc → dist/
npm test                    # end-to-end harness (133 checks, ~10 s)
npm start                   # node dist/index.js  (or: npm run dev for tsx)
```

`.env` needs at minimum:

```bash
AGENT_GAMES_HMAC_SECRET=   # one-time plaintext from dashboard → Rotate Secret
KURIER_API_KEY=            # from https://kurier.xyz (mainnet) or https://testnet.kurier.xyz
```

Use **testnet first**: `KURIER_API_URL=https://api-testnet.kurier.xyz/api/v1`
and `KURIER_VK_REGISTERED=false` (the agent registers the VK once at
startup and uses the returned hash). Mainnet: the gatekeeper VK is already
registered, so `KURIER_VK_REGISTERED=true`.

## Deploy

The platform requires a **public HTTPS endpoint** and you must register the
**full handler path** (e.g. `https://your-host/agent`), not just the domain.

- **Behind a TLS proxy (recommended):** run `npm start` (plain HTTP on
  `PORT`, default 3000) behind Fly.io / Railway / Render / Caddy / nginx,
  which terminates TLS. Register the public `https://…/agent` URL.
- **Direct TLS:** set `TLS_KEY_PATH` + `TLS_CERT_PATH` and the agent serves
  HTTPS itself.
- `GET /health` returns `{ ok, protocolVersion, mode, uptimeSec,
  proofsRecorded }` for load-balancer checks (unsigned).

Then, on the dashboard: **Rotate Secret** → copy the one-time plaintext →
set `AGENT_GAMES_HMAC_SECRET` → restart → run **preflight** from the
dashboard. It must pass before the platform marks you active.

## Kurier finalization policy (strict mode)

`REQUIRE_KURIER_FINALIZED=true` (default): an APPROVE requires the Kurier
job to reach **Finalized** within `KURIER_FINALIZE_TIMEOUT_MS` (default
40 s, inside the 60 s response deadline). If it does not, the agent flips
to `REJECT` / `KURIER_NOT_FINALIZED` — with no proof, because the circuit
expected APPROVE. Kurier finalization typically takes ~15 s, so this
rarely triggers; it is the fail-closed behaviour the protocol asks for.
Set `REQUIRE_KURIER_FINALIZED=false` to approve on a locally verified
proof + successful Kurier submission instead (the platform re-verifies the
proof itself).

For REJECTs that carry a proof, Kurier submission is best-effort (≤ 10 s)
and never blocks the response.

## Test harness

`npm test` boots the compiled server on a random port with a test secret
and Kurier disabled, then replays the samples in `test/samples/`:

| Sample | Expected |
|---|---|
| `task-valid.json` | APPROVE / OK, proof verifies |
| `task-vk-substitution.json` | REJECT / VK_SUBSTITUTION, no proof |
| `task-vk-mismatch.json` | REJECT / VK_MISMATCH, proof verifies |
| `task-below-minimum.json` | REJECT / BELOW_MINIMUM, proof verifies |
| `task-recipient-mismatch.json` | REJECT / RECIPIENT_MISMATCH, proof verifies |
| `task-amount-exceeds.json` | REJECT / AMOUNT_EXCEEDS_MAX, proof verifies |
| `task-expired.json` | REJECT / EXPIRED, proof verifies |
| `preflight.json` | `{ ok: true, protocolVersion: "v1" }`, signed |
| replay of `task-valid.json` | REJECT / TASK_REPLAY, no proof |
| wrong secret / tampered body | 401 |

For every proof the harness checks all 13 public signals against the task
(including `binding == Poseidon(salt, taskId)` using the salt from the
proof log) and verifies the proof locally against the exported VK.
**133 checks, 0 failures** (3 consecutive clean runs).

## Assumptions to confirm with the platform

Two protocol details are not spelled out on `/build` and are implemented
with the standard choice, isolated to a single place each:

1. **`taskId` encoding** (`src/circuit.ts → encodeTaskId`):
   `keccak256(utf8(task_id)) mod FIELD_PRIME` — the standard EVM-world
   string-to-field encoding (the platform's own docs use keccak256 + viem
   for the same purpose). If the platform documents a different encoding,
   change only this function.
2. **HMAC algorithm** (`HMAC_ALGORITHM`, default `sha256`): HMAC-SHA256,
   hex-encoded, over the raw body. Flip to `sha512` via env if the
   dashboard ever indicates otherwise.

## Security notes

- Secrets live only in environment variables. `.env` and `data/` are
  gitignored; `.env.example` ships blank values. Never paste a private
  key, seed phrase, or API key into a chat, a prompt, or a commit.
- The proof log (`data/proofs.json`) contains per-task salts — local-only,
  never shared.
- Replay protection is twofold: seen `task_id`s and seen proof bindings
  (public signal 0) are both rejected.
- The HMAC secret is the platform-generated value from Rotate Secret —
  never a local placeholder. A mismatched secret fails preflight loudly.
