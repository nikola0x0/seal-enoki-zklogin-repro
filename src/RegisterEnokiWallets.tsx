import { useEffect } from "react";
import { useCurrentClient, useCurrentNetwork } from "@mysten/dapp-kit-react";
import { isEnokiNetwork, registerEnokiWallets } from "@mysten/enoki";

export function RegisterEnokiWallets() {
  const client = useCurrentClient();
  const network = useCurrentNetwork();
  const redirectUrl = new URL(
    window.location.pathname,
    window.location.origin,
  ).toString();

  useEffect(() => {
    const apiKey = import.meta.env.VITE_ENOKI_API_KEY;
    const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    if (!apiKey || !googleClientId || !isEnokiNetwork(network)) return;

    const { unregister } = registerEnokiWallets({
      apiKey,
      providers: { google: { clientId: googleClientId, redirectUrl } },
      client: client as never,
      network,
    });
    return unregister;
  }, [client, network, redirectUrl]);

  return null;
}
