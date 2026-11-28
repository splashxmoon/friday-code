import { PushRelay, pushConfigFromEnv, relayServer } from "./push-relay.js";
import os from "node:os";
import path from "node:path";
import { ReachRelay, fileClaims } from "./reach-relay.js";

/**
 * Friday's relay, run yourself (docs/push-relay.md): `npm run relay`. Two things on one port:
 *   - reaching your computer from anywhere (reach-relay.ts), at /api/relay/…, which needs nothing set;
 *   - notifications to the iPhone app (push-relay.ts), at /api/push/relay, which needs APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID and
 *     APNS_TOPIC for the app you build.
 * PORT to listen on (8790 by default), TRUST_PROXY=1 behind a proxy that sets X-Forwarded-For, RELAY_CLAIMS for where the ids
 * computers hold are kept (~/.friday-relay/claims.json by default). Point each computer's Friday at it
 * with FRIDAY_RELAY=wss://<your host>/api/relay and FRIDAY_PUSH_RELAY=https://<your host>/api/push/relay.
 */
const config = pushConfigFromEnv(process.env);
const port = Number(process.env.PORT) || 8790;
const trustProxy = process.env.TRUST_PROXY === "1";
// Which secret holds which id, kept across restarts (RELAY_CLAIMS names the file): forgotten, anyone who knew an id could claim it.
const reach = new ReachRelay({ claims: fileClaims(process.env.RELAY_CLAIMS?.trim() || path.join(os.homedir(), ".friday-relay", "claims.json")), log: (l) => console.log(`[relay] ${l}`) });
const server = relayServer(new PushRelay(config), { trustProxy, reach });
server.listen(port, () => {
  console.log(`Friday relay on port ${port}: reaching computers at /api/relay; notifications ${config ? `for ${config.topic}` : "off (no Apple key: APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID)"}`);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (reach.close(), server.close(() => process.exit(0))));
