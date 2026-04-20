# Seal + Enoki zkLogin repro

Minimal reproduction and root-cause investigation for
[MystenLabs/seal#531](https://github.com/MystenLabs/seal/issues/531):
`InvalidUserSignatureError` when fetching Seal keys with an Enoki/zkLogin
wallet, while the same flow succeeds with a standard browser wallet.

**Short version of the conclusion** — the bug is **not** in Seal and **not** in
Enoki. It's in `MystenLabs/sui`'s gRPC `signature_verification_service`, which
selects the *dev* zkLogin verifier on testnet while the corresponding JSON-RPC
endpoint selects *Prod*. Enoki proofs are issued for Prod, so the gRPC route
rejects valid signatures. Seal's key server delegates verification through the
gRPC route, so users see `InvalidUserSignatureError`. Details below.

## Pinned versions (latest at the time of writing)

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

The decisive line is `sui_verifyZkLoginSignature: success:true` for Enoki —
Sui's own JSON-RPC verifier confirms the signature is valid for that address,
yet the Seal key server (which uses a different verification path) returns
`InvalidSignature`.

## Investigation chain

1. **Symptom**: Seal `fetchKeys` returns `InvalidUserSignatureError` (HTTP 403,
   `error: "InvalidSignature"`) for Enoki users; succeeds (or fails with
   `NoAccessError`, depending on the access policy) for Slush.

2. **Initial wrong hypothesis (PR #516 alias check)**: Seal's
   `crates/key-server/src/server.rs:352` short-circuits with `InvalidSignature`
   when `has_address_aliases(cert.user)` returns `true`. Verified empirically
   via `check-alias.mjs` (snapshot self-test passes; both Enoki and Slush
   addresses return `notExists` for the derived `AliasKey<address>` object).
   So the alias check is NOT firing — it's not the cause.

3. **Real verifier path**: Seal calls
   `sui_sdk::verify_personal_message_signature::verify_personal_message_signature`,
   which for `GenericSignature::ZkLoginAuthenticator` delegates to Sui gRPC's
   `signature_verification_client.verify_signature`.

4. **Cross-check**: Calling Sui's JSON-RPC `sui_verifyZkLoginSignature`
   (`crates/sui-json-rpc/src/read_api.rs`) directly with the same cert
   signature and message returns `{success: true}`.

5. **Divergence located**:

   **Sui JSON-RPC (`read_api.rs:1178-1182`) — Prod on testnet, works:**
   ```rust
   let zklogin_env_native = match self.state.get_chain_identifier()...chain() {
       Chain::Mainnet | Chain::Testnet => ZkLoginEnv::Prod,
       _ => ZkLoginEnv::Test,
   };
   ```

   **Sui gRPC (`signature_verification_service.rs:178-182`) — Dev on testnet, fails:**
   ```rust
   let mut zklogin_verifier = match service.chain_id().chain() {
       Chain::Mainnet => ZkloginVerifier::new_mainnet(),
       Chain::Testnet | Chain::Unknown => ZkloginVerifier::new_dev(),
   };
   ```

   Same input, opposite environment. Enoki proofs are issued for Prod, so the
   gRPC's Dev verifier rejects them.

## Files

- `src/App.tsx` — the repro UI: builds a Seal `SessionKey`, calls
  `getCertificate()`, hits Sui's JSON-RPC `sui_verifyZkLoginSignature`
  directly for cross-check, then calls `sealClient.fetchKeys` to surface the
  Seal-side error.
- `check-alias.mjs` — Node script that derives the `AliasKey<address>`
  derived-object ID for both test addresses and queries Sui testnet for them.
  Verifies the alias-check hypothesis is not the cause. Includes a
  self-test against the snapshot in `crates/sui-types/src/derived_object.rs`.

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
