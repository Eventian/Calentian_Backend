import express from "express";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4150;

// ✨ CORS aktivieren
app.use(
  cors({
    origin: ["http://localhost:4200", "https://angebote.calentian.de"],
    methods: ["GET", "POST"],
  })
);
// MySQL-Pool (wie bei deinen anderen Services)
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER || "calentian_offer_reader",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "calentian",
  waitForConnections: true,
  connectionLimit: 10,
});

app.get("/database-angebotsgenerator/:hash", async (req, res) => {
  const hash = req.params.hash?.trim();

  console.log("📥 Anfrage empfangen:");
  console.log("👉 Hash:", hash);
  console.log("👉 URL:", req.originalUrl);
  console.log("👉 Params:", req.params);
  console.log("👉 Query:", req.query);

  if (!/^([a-zA-Z0-9]{5}-){5}[a-zA-Z0-9]{5}$/.test(hash)) {
    return res.status(400).json({ error: "Ungültiger Hash" });
  }

  try {
    // 🔹 1. Angebot + Event + Kundendaten laden
    const [offerRows] = await pool.query(
      `
      SELECT 
        o.*, 
        e.event_name, 
         e.datum AS event_date,
        k.vorname AS customer_firstname,
        k.nachname AS customer_lastname,
        k.firma AS customer_company
      FROM calentian_offer o
      LEFT JOIN calentian_event_entries e ON o.calentian_event_entries_id = e.id
      LEFT JOIN calentian_kundendaten k ON e.calentian_kundendaten_id = k.id
      WHERE o.hash = ?
      LIMIT 1
      `,
      [hash]
    );

    if (offerRows.length === 0) {
      return res.status(404).json({ error: "Angebot nicht gefunden" });
    }

    const offer = offerRows[0];

    // 🔹 2. Positionen laden
    const [itemRows] = await pool.query(
      `
      SELECT
        i.id AS item_id,
        i.title AS item_title,
        i.description AS item_description,
        i.unit_price,
        i.quantity,
        i.unit,
        i.optional,
        i.selected_by_default,
        i.can_edit_quantity,
        i.can_remove,
        i.min_quantity,
        i.max_quantity,
        i.group_id,
        i.group_type,
        i.group_title,
        i.referenced_item_id,
        p.title AS product_title,
        p.description AS product_description,
        c.name AS category
      FROM calentian_offer_item i
      LEFT JOIN calentian_offer_product p ON i.product_id = p.id
      LEFT JOIN calentian_offer_product_category c ON p.category_id = c.id
      WHERE i.offer_id = ?
      ORDER BY i.group_id, i.id
      `,
      [offer.id]
    );

    const items = itemRows.map((row) => ({
      id: row.item_id,
      title: row.item_title,
      description: row.item_description,
      unit_price: parseFloat(row.unit_price),
      quantity: row.quantity,
      unit: row.unit,
      optional: !!row.optional,
      can_edit_quantity: !!row.can_edit_quantity,
      can_remove: !!row.can_remove,
      min_quantity: row.min_quantity,
      max_quantity: row.max_quantity,
      group_id: row.group_id,
      group_type: row.group_type,
      group_title: row.group_title,
      referenced_item_id: row.referenced_item_id,
      product: {
        title: row.product_title,
        description: row.product_description,
        category: row.category,
      },
      selected: !row.optional || !!row.selected_by_default,
      selected_by_default: !!row.selected_by_default,
    }));

    // 🔹 3. JSON-Antwort zurückgeben
    res.json({
      id: offer.id,
      status: offer.status,
      hash: offer.hash,
      valid_until: offer.valid_until,
      created_at: offer.created_at,
      updated_at: offer.updated_at,
      introduction: offer.introduction,
      down_payment_type: offer.down_payment_type,
      down_payment_value: offer.down_payment_value,
      event_name: offer.event_name,
      event_date: offer.event_date,
      customer_firstname: offer.customer_firstname,
      customer_lastname: offer.customer_lastname,
      customer_company: offer.customer_company,
      items,
    });
  } catch (err) {
    console.error("❌ DB-Fehler:", err);
    res.status(500).json({ error: "Interner Fehler" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Angebots-API läuft auf Port ${PORT}`);
});
