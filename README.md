# Seal + Enoki zkLogin repro

Minimal reproduction of
[mysten-labs/seal#531](https://github.com/MystenLabs/seal/issues/531):
`InvalidUserSignatureError` when fetching Seal keys with an Enoki/zkLogin
wallet, while the same flow succeeds with a standard browser wallet (Slush).

## Pinned versions (same as the original report)

| Package                   | Version   |
| ------------------------- | --------- |
| `@mysten/seal`            | ^1.1.1    |
| `@mysten/enoki`           | ^1.0.4    |
| `@mysten/dapp-kit-react`  | ^2.0.1    |
| `@mysten/sui`             | ^2.14.1   |

## Run

```bash
cp .env.example .env          # fill in VITE_ENOKI_API_KEY + VITE_GOOGLE_CLIENT_ID
npm install
npm run dev
```

Open the dev server, connect a wallet, click **Run Seal session-key test**.

## What you should see

### Enoki (Google sign-in)

```
certificate.signature.length = 1300
fetchKeys threw InvalidUserSignatureError: ...
==> bug reproduced
```

### Slush

```
certificate.signature.length = 132
fetchKeys threw NoAccessError: ...
==> cert accepted, policy denied (expected — we pass a bogus id)
```

The key observation: **the Slush run gets past certificate verification on the
key server** (and only then fails access control), while the Enoki run is
rejected on the certificate itself. Per the upstream issue, the Seal key
server's certificate verifier does not handle the zkLogin-wrapped personal
message signature that Enoki v1.x returns from `signPersonalMessage`.

## What the repro code does

1. Builds a `SessionKey` using the new v1.x signer API:
   `new CurrentAccountSigner(dAppKit)` passed into `SessionKey.create`.
2. Calls `sessionKey.getCertificate()` which triggers `signPersonalMessage` on
   the connected wallet and logs the resulting signature length.
3. Calls `sealClient.fetchKeys` with dummy inputs — enough to force the key
   server to verify the certificate without needing a real encrypted object.

See `src/App.tsx`.
