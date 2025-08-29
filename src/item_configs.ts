/**
 * Loads every card JSON, merges it with the shared base template
 * and exports a single array ready for injection.
 */

import fs   from "fs";
import path from "path";

// ─────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────
const singleFilePath  = path.resolve(__dirname, "../config/cards.json");
const baseConfigPath  = path.resolve(__dirname, "../config/card_base.json");

// ─────────────────────────────────────────────────────────────
// Load base template once
// ─────────────────────────────────────────────────────────────
const baseConfig = JSON.parse(fs.readFileSync(baseConfigPath, "utf-8"));

// ─────────────────────────────────────────────────────────────
// Merge helper (shallow is enough, nested objects all come
// entirely from baseConfig)
// ─────────────────────────────────────────────────────────────
function mergeCard(overrides: Record<string, any>): Record<string, any> {
    return { ...baseConfig, ...overrides };
}

// ─────────────────────────────────────────────────────────────
// Read + merge every card
// ─────────────────────────────────────────────────────────────
function loadFromSingleFile(): Record<string, any>[] {
    if (!fs.existsSync(singleFilePath)) {
        const msg = "Missing config/cards.json";
        console.error(msg);
        throw new Error(msg);
    }

    const raw = fs.readFileSync(singleFilePath, "utf-8");
    const json = JSON.parse(raw);

    const cardsArray: any[] = Array.isArray(json) ? json : (Array.isArray((json as any)?.cards) ? (json as any).cards : null);
    if (!Array.isArray(cardsArray)) {
        throw new Error("config/cards.json must be an array of card objects or an object with a 'cards' array");
    }

    return cardsArray.map(card => mergeCard(card));
}

export const customItemConfigs = loadFromSingleFile();
