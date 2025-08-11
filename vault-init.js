// vault-init.js
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const VAULT_ADDR = process.env.VAULT_ADDR || "https://vault.calentian.de";
const VAULT_TOKEN = process.env.VAULT_TOKEN; // lokal
const ROLE_ID = process.env.VAULT_ROLE_ID; // prod
const SECRET_ID = process.env.VAULT_SECRET_ID;
const VAULT_NAMESPACE = process.env.VAULT_NAMESPACE; // optional
const ENV = process.env.VAULT_ENV || "prod"; // z.B. prod/dev
const VAULT_SECRETS = (process.env.VAULT_SECRETS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export default async function initVault() {
  try {
    if (!VAULT_ADDR) throw new Error("VAULT_ADDR fehlt");
    if (!VAULT_SECRETS.length) throw new Error("VAULT_SECRETS ist leer");

    // 1) Auth: Token bevorzugen (lokal), sonst AppRole (prod)
    let clientToken = VAULT_TOKEN;
    if (clientToken) {
      console.log("🔑 Vault: Direktes Token wird verwendet");
    } else {
      if (!ROLE_ID || !SECRET_ID) {
        throw new Error(
          "Weder VAULT_TOKEN noch (VAULT_ROLE_ID & VAULT_SECRET_ID) gesetzt"
        );
      }
      console.log("🔑 Vault: AppRole-Login");
      const loginRes = await axios.post(
        `${VAULT_ADDR}/v1/auth/approle/login`,
        {
          role_id: ROLE_ID,
          secret_id: SECRET_ID,
        },
        VAULT_NAMESPACE
          ? { headers: { "X-Vault-Namespace": VAULT_NAMESPACE } }
          : undefined
      );
      clientToken = loginRes.data?.auth?.client_token;
      if (!clientToken)
        throw new Error("Kein client_token im AppRole-Login erhalten");
    }

    // 2) Secrets laden (KVv2: /v1/secret/data/<ENV>/<path>)
    const baseHeaders = {
      "X-Vault-Token": clientToken,
      ...(VAULT_NAMESPACE ? { "X-Vault-Namespace": VAULT_NAMESPACE } : {}),
    };

    for (const path of VAULT_SECRETS) {
      const url = `${VAULT_ADDR}/v1/secret/data/${ENV}/${path}`.replace(
        /\/+/g,
        "/"
      );
      console.log(`🔍 Lade Secret: ${url}`);
      const res = await axios.get(url, { headers: baseHeaders });
      const kv = res.data?.data?.data;
      if (!kv) throw new Error(`Leere Daten für Pfad ${path}`);

      for (const [k, v] of Object.entries(kv)) process.env[k] = String(v);
      console.log(`✅ Secret '${path}' geladen`);
    }

    return true;
  } catch (err) {
    const msg = err.response?.data || err.message || err;
    console.error("❌ Fehler beim Vault-Zugriff:", msg);
    process.exit(1);
  }
}
