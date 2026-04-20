import { useState } from "react";
import {
  CurrentAccountSigner,
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
  useWallets,
} from "@mysten/dapp-kit-react";
import { SessionKey, SealClient, type KeyServerConfig } from "@mysten/seal";
import { Transaction } from "@mysten/sui/transactions";

type Log = { level: "info" | "error"; line: string };

// Mysten testnet aggregator (decentralized committee) — same as the reporter's repo.
const TESTNET_KEY_SERVERS: KeyServerConfig[] = [
  {
    objectId:
      "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98",
    aggregatorUrl: "https://seal-aggregator-testnet.mystenlabs.com",
    weight: 1,
  },
];

// Demo package with a public seal_approve entry point (SEAL example - allowlist).
const DEMO_PACKAGE_ID =
  "0xd95d94e8e4a71623797688dae5393cdf16ac0eec4951e63871490c4c8ad038f9";

export default function App() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const wallets = useWallets();
  const [logs, setLogs] = useState<Log[]>([]);

  const log = (level: Log["level"], line: string) =>
    setLogs((prev) => [...prev, { level, line }]);

  async function connect(walletName: string) {
    const wallet = wallets.find((w) => w.name === walletName);
    if (!wallet) return log("error", `wallet "${walletName}" not available`);
    await dAppKit.connectWallet({ wallet });
  }

  async function run() {
    setLogs([]);
    if (!account) return log("error", "connect a wallet first");

    try {
      log("info", `address: ${account.address}`);

      const signer = new CurrentAccountSigner(dAppKit as never);
      const sessionKey = await SessionKey.create({
        address: account.address,
        packageId: DEMO_PACKAGE_ID,
        ttlMin: 10,
        signer,
        suiClient: client as never,
      });
      log("info", "SessionKey.create OK");

      const cert = await sessionKey.getCertificate();
      log(
        "info",
        `certificate.signature.length = ${cert.signature.length} ` +
          "(Slush ≈ 132, Enoki zkLogin ≈ 1300)",
      );

      // Cross-check the same signature against Sui's two zkLogin verifier
      // routes. The JSON-RPC handler picks ZkLoginEnv::Prod for testnet, the
      // gRPC handler picks new_dev() — so the same cert should accept on one
      // and reject on the other if that selection is what's failing.
      const personalMsg = sessionKey.getPersonalMessage();
      let bytesB64 = "";
      for (const b of personalMsg) bytesB64 += String.fromCharCode(b);
      bytesB64 = btoa(bytesB64);
      log("info", `personal-message len=${personalMsg.length}`);

      // (1) JSON-RPC route
      try {
        const r = await fetch("https://fullnode.testnet.sui.io", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "sui_verifyZkLoginSignature",
            params: [bytesB64, cert.signature, "PersonalMessage", account.address],
          }),
        });
        const j = await r.json();
        log("info", `JSON-RPC  sui_verifyZkLoginSignature: ${JSON.stringify(j.result ?? j.error)}`);
      } catch (e: any) {
        log("error", `JSON-RPC verify call failed: ${e?.message ?? e}`);
      }

      // (2) gRPC route — same inputs, but goes through SuiGrpcClient's
      // signatureVerificationService.verifySignature, which is what
      // sui_sdk::verify_personal_message_signature uses, which is what the
      // Seal key server invokes. If this fails while (1) succeeds, the gRPC
      // handler's verifier selection is the cause.
      try {
        const res = await (client as any).core.verifyZkLoginSignature({
          bytes: bytesB64,
          signature: cert.signature,
          intentScope: "PersonalMessage",
          address: account.address,
        });
        log("info", `gRPC      core.verifyZkLoginSignature:    ${JSON.stringify(res)}`);
      } catch (e: any) {
        log("error", `gRPC verify call failed: ${e?.message ?? e}`);
      }

      const tx = new Transaction();
      tx.moveCall({
        target: `${DEMO_PACKAGE_ID}::allowlist::seal_approve`,
        arguments: [tx.pure.vector("u8", [0, 0, 0, 0]), tx.object("0x6")],
      });
      const txBytes = await tx.build({
        client: client as never,
        onlyTransactionKind: true,
      });

      const sealClient = new SealClient({
        suiClient: client as never,
        serverConfigs: TESTNET_KEY_SERVERS,
        verifyKeyServers: false,
      });

      try {
        await sealClient.fetchKeys({
          ids: ["0x" + "00".repeat(37)],
          txBytes,
          sessionKey,
          threshold: 1,
        });
        log("info", "fetchKeys returned without throwing");
      } catch (err: any) {
        const msg: string = err?.message ?? String(err);
        const name = err?.name ?? err?.constructor?.name ?? "Error";
        log("error", `fetchKeys threw ${name}: ${msg}`);

        const isInvalidSig = /signature on the session key is invalid/i.test(msg)
          || name === "InvalidUserSignatureError";
        const isNoAccess = /does not have access/i.test(msg)
          || name === "NoAccessError";

        if (isInvalidSig) {
          log("info", "==> bug reproduced: Seal key server rejects the cert via Sui gRPC,");
          log("info", "    even though Sui JSON-RPC verifies the same sig as valid (see README).");
        } else if (isNoAccess) {
          log("info", "==> cert accepted by server; access policy denied (expected for bogus id).");
        } else {
          log("info", "==> unexpected error class");
        }
      }
    } catch (e: any) {
      log("error", `setup failed: ${e?.message ?? e}`);
    }
  }

  return (
    <div style={{ fontFamily: "ui-monospace, monospace", padding: 24 }}>
      <h1>Seal + Enoki zkLogin repro</h1>
      <p>
        Minimal reproduction of{" "}
        <a href="https://github.com/MystenLabs/seal/issues/531">
          MystenLabs/seal#531
        </a>
        .
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {wallets.map((w) => (
          <button key={w.name} onClick={() => connect(w.name)}>
            Connect: {w.name}
          </button>
        ))}
      </div>
      <p>
        connected: <code>{account?.address ?? "(none)"}</code>
      </p>
      <button onClick={run} disabled={!account}>
        Run Seal session-key test
      </button>
      <pre
        style={{
          background: "#111",
          color: "#eee",
          padding: 12,
          marginTop: 12,
          minHeight: 240,
          whiteSpace: "pre-wrap",
        }}
      >
        {logs.map((l, i) => (
          <div key={i} style={{ color: l.level === "error" ? "#f88" : "#eee" }}>
            {l.line}
          </div>
        ))}
      </pre>
    </div>
  );
}
