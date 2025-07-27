import { DependencyContainer } from "tsyringe";
import { IPreSptLoadMod, IPostDBLoadMod } from "@spt/models/external";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { DatabaseServer } from "@spt/servers/DatabaseServer";
import { ConfigServer } from "@spt/servers/ConfigServer";
import { JsonUtil } from "@spt/utils/JsonUtil";

import { customItemConfigs } from "./item_configs";
import fs from "fs";
import path from "path";
import JSON5 from "json5";

const cfgPath = path.resolve(__dirname, "../config/mod_config.jsonc");
const modConfig = JSON5.parse(fs.readFileSync(cfgPath, "utf-8"));

let relativeProbabilities: Record<string, any> = {};

// Console color enum for structured logging
enum Color {
    INFO = "blue",
    DEBUG = "yellow",
    ERROR = "red"
}

// Fixed rarity order and mapping for sorting purposes
const rarityOrder = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Secret"] as const;
type Rarity = typeof rarityOrder[number];

const rarityWeight: Record<Rarity, number> = Object.fromEntries(
    rarityOrder.map((r, idx) => [r, idx])
) as Record<Rarity, number>;

/**
 * Compare function to sort cards by rarity and name.
 */
export function sortByRarity(
    a: { rarity: Rarity; item_name: string },
    b: { rarity: Rarity; item_name: string }
): number {
    const diff = rarityWeight[a.rarity] - rarityWeight[b.rarity];
    return diff !== 0 ? diff : a.item_name.localeCompare(b.item_name);
}

export class TarkovTradingCards implements IPreSptLoadMod, IPostDBLoadMod {
    private logger!: ILogger;
    private container!: DependencyContainer;
    private jsonUtil!: JsonUtil;
    private db!: ReturnType<DatabaseServer["getTables"]>;

    private readonly modName = "Tarkov Trading Cards";
    private readonly debug = Boolean(modConfig.debug);
    private configInventory: any;
    private rarityCounts: Record<string, number> = {};
	
	private readonly currencyMap: Record<string, string> = {
		roubles:   "5449016a4bdc2d6f028b456f",
		dollars:   "5696686a4bdc2da3298b456a",
		euros:     "5ac3b934156ae10c4430e83c",
	};

    public preSptLoad(container: DependencyContainer): void {
        this.container = container;
    }

    public postDBLoad(container: DependencyContainer): void {
        this.container = container;
        this.logger = container.resolve<ILogger>("WinstonLogger");
        this.jsonUtil = container.resolve<JsonUtil>("JsonUtil");

        const databaseServer = container.resolve<DatabaseServer>("DatabaseServer");
        this.db = databaseServer.getTables();

        const configServer = container.resolve<ConfigServer>("ConfigServer");
        this.configInventory = configServer.getConfigByString("spt-inventory");

        this.log(Color.INFO, "Initialisation");

        const probPath = path.resolve(__dirname, "../config/probabilities.json");
        if (fs.existsSync(probPath)) {
            relativeProbabilities = JSON.parse(fs.readFileSync(probPath, "utf-8"));
        }

        if ((modConfig as any).auto_update_probabilities) {
            const regenerated = this.generateProbabilities();
            relativeProbabilities = { ...relativeProbabilities, ...regenerated };
            fs.writeFileSync(probPath, JSON.stringify(relativeProbabilities, null, 2));
            this.log(Color.INFO, "probabilities.json auto-updated");
        }

        for (const card of customItemConfigs) {
            this.rarityCounts[card.rarity] = (this.rarityCounts[card.rarity] || 0) + 1;
            try {
                this.injectCard(card);
            } catch (e) {
                this.log(Color.ERROR, `Failed to inject ${card.item_short_name}: ${(e as Error).message}`);
            }
        }

        Object.entries(this.rarityCounts).forEach(([rarity, count]) =>
            this.log(Color.INFO, `→ ${rarity}: ${count} card(s) loaded.`)
        );

        this.extendCardStorageCases();

        const cardsByTheme: Record<string, typeof customItemConfigs> = {};
        for (const card of customItemConfigs) {
            if (!card.theme) continue;
            if (!cardsByTheme[card.theme]) cardsByTheme[card.theme] = [];
            cardsByTheme[card.theme].push(card);
        }

        const emptyBoosterContainer = this.buildEmptyBooster(customItemConfigs);

        for (const [theme, cards] of Object.entries(cardsByTheme)) {
            const binder = this.buildThemedCardBinder(cards, theme);
            customItemConfigs.push(binder);
        }

        customItemConfigs.push(emptyBoosterContainer);
    }

    /**
     * Injects a trading card item into the database, including loot, trader, and handbook integration.
     * @param cfg Card configuration
     */
    private injectCard(cfg: typeof customItemConfigs[number]): void {
        this.ensureCompatFilters();
        this.db.templates.items[cfg.id] = this.buildTemplate(cfg);
        this.addLocales(cfg);
        this.addHandbookEntry(cfg);
        this.addToTrader(cfg);
        this.addToLoot(cfg);
    }

    /**
     * Injects a container item into the game.
     * @param cfg Container configuration
     */
    private injectContainer(cfg: typeof customItemConfigs[number]): void {
        this.ensureCompatFilters();
        this.db.templates.items[cfg.id] = this.buildTemplate(cfg);
        this.addLocales(cfg);
        this.addHandbookEntry(cfg);
        this.addToTrader(cfg);
    }

    /**
     * Builds a new item template from a cloned base and applies overrides from the config.
     * @param cfg Item configuration
     * @returns New item template
     */
    private buildTemplate(cfg: typeof customItemConfigs[number]): any {
        const tpl = this.jsonUtil.clone(this.db.templates.items[cfg.clone_item]);

        tpl._props = { ...tpl._props, ...(cfg as any)._props };

        if ((cfg as any).Slots) tpl.Slots = (cfg as any).Slots;
        if ((cfg as any).Grids) tpl.Grids = (cfg as any).Grids;

        Object.assign(tpl, {
            _id: cfg.id,
            _name: cfg.item_name,
            _parent: cfg.item_parent
        });

        Object.assign(tpl._props, {
            Prefab: { path: cfg.item_prefab_path },
            Name: cfg.item_name,
            ShortName: cfg.item_short_name,
            Description: cfg.item_description,
            BackgroundColor: cfg.color,
            CanSellOnRagfair: cfg.can_sell_on_ragfair,
            StackMaxSize: cfg.stack_max_size,
            Weight: cfg.weight,
            Width: cfg.ExternalSize.width,
            Height: cfg.ExternalSize.height,
            ItemSound: cfg.item_sound,
            QuestItem: false,
            InsuranceDisabled: true,
            ExaminedByDefault: true
        });

        return tpl;
    }

    /**
     * Adds localization strings for all supported languages.
     * @param cfg Item configuration
     */
    private addLocales(cfg: typeof customItemConfigs[number]): void {
        for (const locale of Object.values(this.db.locales.global) as Record<string, string>[]) {
            locale[`${cfg.id} Name`] = cfg.item_name;
            locale[`${cfg.id} ShortName`] = cfg.item_short_name;
            locale[`${cfg.id} Description`] = cfg.item_description;
        }
    }

    /**
     * Adds an item entry to the in-game handbook.
     * @param cfg Item configuration
     */
    private addHandbookEntry(cfg: typeof customItemConfigs[number]): void {
        this.db.templates.handbook.Items.push({ Id: cfg.id, ParentId: cfg.category_id, Price: cfg.price });
    }

    /**
     * Adds the item to a trader’s assortment if marked as sold in config.
     * @param cfg Item configuration
     */
    private addToTrader(cfg: typeof customItemConfigs[number]): void {
        if (!cfg.sold) return;

        const trader = this.db.traders[cfg.trader] ?? this.db.traders[modConfig.fallback_trader];
        if (!trader) return this.log(Color.DEBUG, `Trader ${cfg.trader} not found for ${cfg.item_short_name}`);

        const currencyTpl = this.currencyMap[cfg.currency] ?? cfg.currency;

        trader.assort.items.push({
            _id: cfg.id,
            _tpl: cfg.id,
            parentId: "hideout",
            slotId: "hideout",
            upd: {
                UnlimitedCount: cfg.unlimited_stock,
                StackObjectsCount: cfg.stock_amount
            }
        });

        trader.assort.barter_scheme[cfg.id] = [[{ count: cfg.price, _tpl: currencyTpl }]];
        trader.assort.loyal_level_items[cfg.id] = cfg.trader_loyalty_level;
    }

    /**
     * Adds the item to static loot containers on specified maps, with probability based on rarity.
     * @param cfg Item configuration
     */
    private addToLoot(cfg: typeof customItemConfigs[number]): void {
        if (!cfg.lootable || !modConfig.enable_container_spawns) return;

        const rarityTotal = this.rarityCounts[cfg.rarity] ?? 1;

        for (const [mapName, containers] of Object.entries(cfg.loot_locations)) {
            const map = this.db.locations[mapName];
            if (!map) {
                this.log(Color.DEBUG, `Map '${mapName}' not found when adding ${cfg.item_short_name}`);
                continue;
            }

            for (const containerId of containers) {
                const baseStats = (relativeProbabilities as any)[mapName]?.[containerId];
                if (!baseStats) {
                    this.log(Color.DEBUG, `No probability data for container ${containerId} on ${mapName}`);
                    continue;
                }

                const rarityWeight = (modConfig as any)[cfg.rarity];
                const userMult = (modConfig as any).card_weight_multiplier ?? 1;
                const globalMult = userMult * 0.2;
                const perRarityPool = baseStats.max_found * globalMult * rarityWeight;
                const relProb = Math.max(1, Math.ceil(perRarityPool / rarityTotal));

                map.staticLoot[containerId] ??= { itemDistribution: [] } as any;
                map.staticLoot[containerId].itemDistribution.push({
                    tpl: cfg.id,
                    relativeProbability: relProb
                });

                this.log(
                    Color.DEBUG,
                    `Add ${cfg.item_short_name} -> ${mapName}/${containerId}` +
                    ` | rarityPool=${perRarityPool} | relProb=${relProb}`
                );
            }
        }
    }

    /**
     * Iterates over all maps/containers to generate total loot weight data
     * used to normalize probability injection.
     * @returns Probabilities object
     */
    private generateProbabilities(): Record<string, any> {
        const out: Record<string, any> = {};

        for (const [mapName, map] of Object.entries(this.db.locations)) {
            const staticLoot = (map as any).staticLoot;
            if (!staticLoot) continue;

            for (const [containerId, container] of Object.entries(staticLoot)) {
                const dist = (container as any).itemDistribution as { relativeProbability: number }[];
                if (!Array.isArray(dist) || dist.length === 0) continue;

                const total = dist.reduce((s, i) => s + (i.relativeProbability ?? 0), 0);
                if (total === 0) continue;

                out[mapName] ??= {};
                out[mapName][containerId] = {
                    min_found: 1,
                    max_found: total,
                    average: Math.round(total / 2),
                    "15p": Math.round(total * 0.15),
                    "65p": Math.round(total * 0.65)
                };
            }
        }

        return out;
    }

    /**
     * Extends the filter of SICC/DOC cases to accept all custom card template IDs.
     */
    private extendCardStorageCases(): void {
        const itemsTable = this.db.templates.items;

        const targetCases = [
            "5d235bb686f77443f4331278", // S I C C
            "590c60fc86f77412b13fddcf"  // DOC
        ];

        const cardTpls = customItemConfigs.map(c => c.id);
        let totalInserted = 0;

        for (const caseTpl of targetCases) {
            const container = itemsTable[caseTpl];
            if (!container?._props?.Grids) {
                this.log(Color.ERROR, `Container ${caseTpl} not found – cannot extend its filter`);
                continue;
            }

            for (const grid of container._props.Grids) {
                for (const filter of grid._props.filters) {
                    for (const tpl of cardTpls) {
                        if (!filter.Filter.includes(tpl)) {
                            filter.Filter.push(tpl);
                            totalInserted++;
                        }
                    }
                }
            }
        }

        this.log(
            Color.INFO,
            totalInserted > 0
                ? `TTC cards injected into SICC & DOC filters (${totalInserted} insertions)`
                : "TTC cards already present in SICC & DOC filters"
        );
    }

    /**
     * Builds a themed card binder containing only cards from a specific theme.
     * @param cards All cards of the theme
     * @param theme Name of the theme (used for naming and loading correct config file)
     */
    private buildThemedCardBinder(cards: any[], theme: string): any {
        const binderBase = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, "../config/binder_base.json"), "utf-8")
        );
        const themeBinderPath = path.resolve(__dirname, `../config/containers/ttc_binder_${theme}.json`);
        const binderOverride = JSON.parse(fs.readFileSync(themeBinderPath, "utf-8"));

        const binder = { ...binderBase, ...binderOverride };
        const mountProps = this.db.templates.items[binderBase.clone_item]._props;
        const genId = () => (Date.now().toString(16) + Math.random().toString(16)).slice(0, 24);

        binder._props = {
            ...mountProps,
            Width: 1,
            Height: 1,
            Slots: cards
                .slice()
                .sort(sortByRarity)
                .map(c => ({
                    _id: genId(),
                    _name: `mod_mount_${c.id}`,
                    _parent: binder.id,
                    _type: "Slot",
                    _props: {
                        filters: [{ Filter: [c.id], ExcludedFilter: [] }],
                        required: false,
                        max_count: 1,
                        iconId: "mount"
                    }
                }))
        };

        binder.item_parent = this.db.templates.items[binderBase.clone_item]._parent;
        this.injectContainer(binder);
        this.log(Color.INFO, `Card binder '${theme}' built with ${cards.length} cards`);
        return binder;
    }

    private buildEmptyBooster(cards: any[]): any {
        const containerBase = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, "../config/container_base.json"), "utf-8")
        );
        const emptyBoosterOverride = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, "../config/containers/ttc_empty_booster_pack.json"), "utf-8")
        );

        const emptyBooster = { ...containerBase, ...emptyBoosterOverride };
        const iCaseProps = this.db.templates.items[containerBase.clone_item]._props;
        const side = 4;  
        const allowedTpls = cards.map(c => c.id);

        emptyBooster._props = {
            ...iCaseProps,
            Width: 1,
            Height: 1,
            Grids: [
                {
                    _name: "emptyBooster",
                    _props: {
                        cellsH: side,
                        cellsV: side,
                        minCount: 0,
                        filters: [
                            {
                                Filter: allowedTpls,
                                ExcludedFilter: []
                            }
                        ]
                    }
                }
            ]
        };

        this.injectContainer(emptyBooster);

        this.log(Color.INFO, `Empty Booster built successfully, accepting ${cards.length} cards`);

        return emptyBooster;
    }

    /**
     * Ensures older gear containers have valid filters so card insertion doesn't break them.
     */
    private ensureCompatFilters(): void {
        const compat = [{ Filter: ["54009119af1c881c07000029"], ExcludedFilter: [""] }];
        for (const item of Object.values(this.db.templates.items)) {
            if (["5448e53e4bdc2d60728b4567", "5448bf274bdc2dfc2f8b456a"].includes(item._parent) && item._id !== "5c0a794586f77461c458f892") {
                if (!item._props.Grids[0]._props.filters) item._props.Grids[0]._props.filters = compat;
            }
        }
    }

    /**
     * Central logging method to print mod info to the SPT console.
     * Respects debug flag.
     * @param color Console text color
     * @param msg Message to display
     */
    private log(color: Color, msg: string): void {
        if (color === Color.DEBUG && !this.debug) return;
        this.logger.log(`[${this.modName}] ${msg}`, color);
    }
}

module.exports = { mod: new TarkovTradingCards() };