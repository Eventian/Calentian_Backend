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

  if (!/^([a-zA-Z0-9]{5}-){5}[a-zA-Z0-9]{5}$/.test(hash)) {
    return res.status(400).json({ error: "Ungültiger Hash" });
  }

  try {
    // 1. Angebot + Event + Kunde
    const [offerRows] = await pool.query(
      `
      SELECT 
        o.*, 
        e.id AS event_id,
        e.calentian_entries_id,
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

    // 1a. Schriftart aus calentian_offer_settings laden
    const [fontRows] = await pool.query(
      `
      SELECT font
      FROM calentian_offer_settings
      WHERE calentian_entries_id = ?
      LIMIT 1
      `,
      [offer.calentian_entries_id]
    );

    const font = fontRows[0]?.font || "montserrat";

    // 2. Kategorien laden
    const [categories] = await pool.query(
      `SELECT name, sort_order FROM calentian_offer_product_category`
    );
    const CATEGORY_ORDER = {};
    for (const cat of categories) {
      CATEGORY_ORDER[cat.name] = cat.sort_order ?? 999;
    }

    // 3. Gruppen laden mit optional Spalte
    const [groupRows] = await pool.query(
      `SELECT id, title, type, sort_order, optional FROM calentian_offer_item_group WHERE offer_id = ?`,
      [offer.id]
    );
    const groupMap = Object.fromEntries(groupRows.map((g) => [g.id, g]));

    // 4. Items laden
    const [itemRows] = await pool.query(
      `
      SELECT
        i.id AS item_id,
        i.title AS item_title,
        i.teaser AS item_teaser,
        i.description AS item_description,
        i.unit_price,
        i.quantity,
        i.optional,
        i.selected_by_default,
        i.can_edit_quantity,
        i.min_quantity,
        i.max_quantity,
        i.sort_order,
        i.category_id,
        i.calentian_offer_item_group_id AS group_id,
        i.calentian_offer_price_unit_id AS unit_id,
        u.title AS unit_title,
        u.short_title AS unit_short_title,
        u.description AS unit_description,
        u.calculation_type,
        u.calculation_config,
        c.name AS category
      FROM calentian_offer_item i
      LEFT JOIN calentian_offer_price_unit u ON i.calentian_offer_price_unit_id = u.id
      LEFT JOIN calentian_offer_product_category c ON i.category_id = c.id
      WHERE i.offer_id = ?
      `,
      [offer.id]
    );

    // Items gruppieren nach group_id
    const itemsByGroupId = {};
    for (const row of itemRows) {
      const group = groupMap[row.group_id] || null;
      const rawConfig = JSON.parse(row.calculation_config || "{}");

      if (
        (row.calculation_type === "per_guestgroup" ||
          row.calculation_type === "per_hour_guestgroup") &&
        rawConfig.guest_groups_id &&
        !rawConfig.group_ids
      ) {
        rawConfig.group_ids = rawConfig.guest_groups_id;
      }

      const item = {
        id: row.item_id,
        title: row.item_title,
        teaser: row.item_teaser,
        description: row.item_description,
        unit_price: parseFloat(row.unit_price),
        quantity: row.quantity,
        unit: {
          id: row.unit_id,
          title: row.unit_title,
          short_title: row.unit_short_title,
          description: row.unit_description,
          calculation_type: row.calculation_type,
          calculation_config: rawConfig,
        },
        optional: !!row.optional,
        can_edit_quantity: !!row.can_edit_quantity,
        min_quantity: row.min_quantity,
        max_quantity: row.max_quantity,
        sort_order: row.sort_order ?? 0,
        group_id: row.group_id,
        group_type: group?.type ?? null,
        group_title: group?.title ?? null,
        group_optional: !!group?.optional,
        product: {
          category: row.category,
        },
        selected: !!row.selected_by_default, // Falls vorhanden
      };

      if (!itemsByGroupId[item.group_id]) {
        itemsByGroupId[item.group_id] = [];
      }
      itemsByGroupId[item.group_id].push(item);
    }

    // Sortiere Items innerhalb jeder Gruppe nach sort_order & id
    for (const groupId in itemsByGroupId) {
      itemsByGroupId[groupId].sort((a, b) => {
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        return a.id - b.id;
      });
    }

    // 5. Gästegruppen laden
    const [guestGroupRows] = await pool.query(
      `
      SELECT 
        g.id AS group_id,
        g.title,
        g.sort_order,
        gc.guest_count
      FROM calentian_guest_group_template g
      LEFT JOIN calentian_event_guest_count gc 
        ON gc.guest_group_template_id = g.id AND gc.calentian_event_entries_id = ?
      WHERE g.calentian_entries_id = ?
      ORDER BY g.sort_order ASC
      `,
      [offer.event_id, offer.calentian_entries_id]
    );

    const guest_groups = guestGroupRows.map((g) => ({
      id: g.group_id,
      title: g.title,
      count: g.guest_count ?? 0,
    }));

    // 6. Sortiere Gruppen nach sort_order & id
    groupRows.sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return a.id - b.id;
    });

    // 7. Bau die gruppierten Datenstruktur für Response
    const groupsWithItems = groupRows.map((group) => ({
      id: group.id,
      title: group.title,
      type: group.type,
      optional: !!group.optional,
      sort_order: group.sort_order,
      items: itemsByGroupId[group.id] || [],
    }));

    // 8. Antwort senden mit verschachtelter Struktur
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
      font, // Schriftart
      guest_groups,
      groups: groupsWithItems,
    });
  } catch (err) {
    console.error("❌ DB-Fehler:", err);
    res.status(500).json({ error: "Interner Fehler" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Angebots-API läuft auf Port ${PORT}`);
});
