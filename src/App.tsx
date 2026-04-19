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

// Mysten testnet key servers (from issue #531).
const TESTNET_KEY_SERVERS: KeyServerConfig[] = [
  {
    objectId:
      "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a001db7439ec8278106a7df5",
    weight: 1,
  },
  {
    objectId:
      "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
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
        const name = err?.name ?? err?.constructor?.name ?? "Error";
        log("error", `fetchKeys threw ${name}: ${err?.message ?? err}`);
        log(
          "info",
          name === "InvalidUserSignatureError"
            ? "==> bug reproduced (see MystenLabs/seal#531)"
            : "==> different error class — cert likely accepted by server",
        );
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
