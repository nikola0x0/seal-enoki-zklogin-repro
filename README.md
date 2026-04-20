# Seal + Enoki zkLogin repro

Minimal reproduction and root-cause investigation for
[MystenLabs/seal#531](https://github.com/MystenLabs/seal/issues/531):
`InvalidUserSignatureError` when fetching Seal keys with an Enoki/zkLogin
wallet, while the same flow succeeds with a standard browser wallet.

**Summary** — the failure originates in `MystenLabs/sui`'s gRPC
`signature_verification_service`, which selects the *dev* zkLogin verifier on
testnet while the corresponding JSON-RPC endpoint selects *Prod*. Enoki proofs
are issued for Prod, so the gRPC route rejects valid signatures. Seal's key
server delegates zkLogin verification through the gRPC route, which is why the
error surfaces as `InvalidUserSignatureError` on the client.

## Pinned versions

| Package                  | Version  |
| ------------------------ | -------- |
| `@mysten/seal`           | ^1.1.1   |
| `@mysten/enoki`          | ^1.0.4   |
| `@mysten/dapp-kit-react` | ^2.0.1   |
| `@mysten/sui`            | ^2.14.1  |

## Run

```bash
cp .env.example .env          # fill in VITE_ENOKI_API_KEY + VITE_GOOGLE_CLIENT_ID
npm install
npm run dev                   # http://localhost:3000
```

In the browser, click **Sign in with Google** (Enoki) and then **Run Seal
session-key test**. Then disconnect and run again with a standard browser
wallet (Slush, Suiet, etc.) to see the contrast.

## Observed result

### Enoki (Google sign-in) — repro

```
address: 0xfde98f8c4b37cbf7078514e34196013aa7577f78ba11ca0c0fd75a4340f51575
SessionKey.create OK
certificate.signature.length = 1300 (Slush ≈ 132, Enoki zkLogin ≈ 1300)
personal-message len=191
sui_verifyZkLoginSignature: {"success":true,"errors":[]}
fetchKeys threw Error: User signature on the session key is invalid
==> bug reproduced
```

### Slush (or any standard browser wallet) — control

```
certificate.signature.length = 132
sui_verifyZkLoginSignature: {"success":false,"errors":["Endpoint only supports zkLogin signature"]}
fetchKeys threw Error: User does not have access to one or more of the requested keys
==> cert accepted by server; access policy denied (expected for bogus id).
```

## Regression timeline

The Sui gRPC bug has been latent since the v2 services were stabilized
([Sept 2025, sui#23540](https://github.com/MystenLabs/sui/pull/23540)) — but it
wasn't reachable from Seal until **2026-03-20**, when Seal commit
[`a5174db`](https://github.com/MystenLabs/seal/commit/a5174db)
("[chore] update sui pointers", PR #519) swapped the client passed into
`verify_personal_message_signature`:

```diff
 verify_personal_message_signature(
     cert.signature.clone(),
     msg.as_bytes(),
     cert.user,
-    Some(self.sui_rpc_client.sui_client().clone()),    // JSON-RPC-backed client
+    Some(self.sui_rpc_client.sui_grpc_client()),       // gRPC client
 )
```

For zkLogin signatures, the SDK helper picks its verification route from the
client it's given. With the JSON-RPC client it took the JSON-RPC path
(Prod verifier on testnet, works). With the gRPC client it takes the gRPC path
(Dev verifier on testnet, fails). Issue #531 was filed shortly after, on
2026-04-08.

Two issues are involved:

1. **Sui** — `signature_verification_service.rs:178-182` selects the Dev
   zkLogin verifier on testnet while every other Sui code path uses Prod.
   Latent since Sept 2025.
2. **Seal** — the 2026-03-20 client swap activated bug #1 in production
   without zkLogin test coverage to catch it.

Either fix restores Enoki users: reverting the Seal one-liner is fast;
fixing the Sui gRPC verifier is the correct long-term change.

## Files

- `src/App.tsx` — the repro UI. Builds a Seal `SessionKey`, cross-checks
  `cert.signature` directly against Sui's JSON-RPC `sui_verifyZkLoginSignature`,
  then calls `sealClient.fetchKeys`.
- `check-alias.mjs` — Node script that rules out the
  [PR #516](https://github.com/MystenLabs/seal/pull/516) alias check as the
  cause (derives `AliasKey<address>` and queries testnet; neither test
  address has one). Includes a self-test against the snapshot in
  `crates/sui-types/src/derived_object.rs`.

## Source citations

- gRPC verifier (the bug):
  https://github.com/MystenLabs/sui/blob/main/crates/sui-rpc-api/src/grpc/v2/signature_verification_service.rs#L178-L182
- JSON-RPC verifier (works):
  https://github.com/MystenLabs/sui/blob/main/crates/sui-json-rpc/src/read_api.rs#L1178-L1182
- Seal key server cert verification:
  https://github.com/MystenLabs/seal/blob/main/crates/key-server/src/server.rs#L352-L380
- SDK that calls the gRPC verifier:
  https://github.com/MystenLabs/sui/blob/main/crates/sui-sdk/src/verify_personal_message_signature.rs#L37-L47
- Enoki keypair (zkLogin-wraps every personal message sig):
  https://github.com/MystenLabs/ts-sdks/blob/main/packages/enoki/src/EnokiKeypair.ts

## Possible fix

In `crates/sui-rpc-api/src/grpc/v2/signature_verification_service.rs` make the
testnet branch select the same verifier as the JSON-RPC path:

```diff
 let mut zklogin_verifier = match service.chain_id().chain() {
     sui_protocol_config::Chain::Mainnet => sui_crypto::zklogin::ZkloginVerifier::new_mainnet(),
-    sui_protocol_config::Chain::Testnet | sui_protocol_config::Chain::Unknown => {
-        sui_crypto::zklogin::ZkloginVerifier::new_dev()
-    }
+    sui_protocol_config::Chain::Testnet => sui_crypto::zklogin::ZkloginVerifier::new_mainnet(),
+    sui_protocol_config::Chain::Unknown => sui_crypto::zklogin::ZkloginVerifier::new_dev(),
 };
```

Or, if `new_mainnet()` isn't the intended testnet verifier, expose the choice
through `ZkLoginEnv` the same way the JSON-RPC path does. A maintainer should
confirm the right call.
