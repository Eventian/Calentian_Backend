// vault-init.js
import axios from "axios";
import dotenv from "dotenv";

// 🔧 .env laden (falls nicht schon im Hauptscript erfolgt)
dotenv.config();

const VAULT_ADDR = process.env.VAULT_ADDR || "https://vault.calentian.de";
const ROLE_ID = process.env.VAULT_ROLE_ID;
const SECRET_ID = process.env.VAULT_SECRET_ID;
const ENV = process.env.VAULT_ENV || "prod";
const VAULT_SECRETS = (process.env.VAULT_SECRETS || "")
  .split(",")
  .map((s) => s.trim());

export default async function initVault() {
  try {
    // 🔐 1. Login via AppRole
    const loginRes = await axios.post(`${VAULT_ADDR}/v1/auth/approle/login`, {
      role_id: ROLE_ID,
      secret_id: SECRET_ID,
    });

    const clientToken = loginRes.data.auth.client_token;

    // 📦 2. Secrets laden
    for (const path of VAULT_SECRETS) {
      const fullPath = `${VAULT_ADDR}/v1/secret/data/${ENV}/${path}`;
      console.log(`🔍 Versuche Secret abzurufen: ${fullPath}`);

      const secretRes = await axios.get(fullPath, {
        headers: {
          "X-Vault-Token": clientToken,
        },
      });

      const data = secretRes.data.data.data;
      for (const [key, value] of Object.entries(data)) {
        process.env[key] = value;
      }

      console.log(`✅ Secret '${path}' geladen`);
      console.log("🔑 ROLE_ID:", ROLE_ID);
      console.log("🔑 SECRET_ID:", SECRET_ID);
    }

    return true;
  } catch (err) {
    console.error(
      "❌ Fehler beim Vault-Zugriff:",
      err.response?.data || err.message
    );
    process.exit(1);
  }
}
