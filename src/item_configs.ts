/**
 * Loads every card JSON, merges it with the shared base template
 * and exports a single array ready for injection.
 */

import fs   from "fs";
import path from "path";

// ─────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────
const cardsDir        = path.resolve(__dirname, "../config/cards");
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
export const customItemConfigs = fs
    .readdirSync(cardsDir)
    .filter(file => file.endsWith(".json"))
    .map(file => {
        const cardOverrides = JSON.parse(
            fs.readFileSync(path.join(cardsDir, file), "utf-8")
        );
        return mergeCard(cardOverrides);
    });
