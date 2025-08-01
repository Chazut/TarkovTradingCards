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

        // Validate rarity weights before proceeding
        this.validateRarityWeights();

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
        this.extendPouchFilters(); // Add this line

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
        this.addToRagfair(cfg);
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

        // Single global config controls both buying and selling on flea market
        const canTradeOnFlea = (modConfig as any).cards_tradeable_on_flea ?? false;

        // Calculate trader sell price based on rarity
        const traderSellPrice = this.calculateTraderPrice(cfg);

        // Debug logging for flea market configuration
        if (canTradeOnFlea) {
            this.log(Color.DEBUG, `Card ${cfg.item_short_name} configured for flea market trading`);
        }

        Object.assign(tpl._props, {
            Prefab: { path: cfg.item_prefab_path },
            Name: cfg.item_name,
            ShortName: cfg.item_short_name,
            Description: cfg.item_description,
            BackgroundColor: cfg.color,
            CanSellOnRagfair: canTradeOnFlea,
            CanRequireOnRagfair: canTradeOnFlea,
            ConflictingItems: [],
            Unlootable: false,
            UnlootableFromSlot: "FirstPrimaryWeapon",
            UnlootableFromSide: [],
            AnimationVariantsNumber: 0,
            DiscardingBlock: false,
            RagFairCommissionModifier: 1,
            IsAlwaysAvailableForInsurance: false,
            StackMaxSize: cfg.stack_max_size,
            Weight: cfg.weight,
            Width: cfg.ExternalSize.width,
            Height: cfg.ExternalSize.height,
            ItemSound: cfg.item_sound,
            QuestItem: false,
            InsuranceDisabled: true,
            ExaminedByDefault: (cfg as any).examined_by_default ?? (modConfig as any).cards_examined_by_default ?? false
        });

        return tpl;
    }

    /**
     * Calculate the trader sell price for a card based on its rarity.
     * @param cfg Item configuration
     * @returns Calculated price
     */
    private calculateTraderPrice(cfg: typeof customItemConfigs[number]): number {
        const cardPrice = cfg.price;
        
        // If card has individual price > 0, use it
        if (cardPrice !== null && cardPrice !== undefined && cardPrice > 0) {
            return cardPrice;
        }
        
        // If card price is -1 or not set, use global config price by rarity
        return (modConfig as any).trader_sell_prices?.[cfg.rarity] ?? 1000;
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
        const price = this.calculateTraderPrice(cfg);
        this.db.templates.handbook.Items.push({ Id: cfg.id, ParentId: cfg.category_id, Price: price });
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
        const price = this.calculateTraderPrice(cfg);

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

        trader.assort.barter_scheme[cfg.id] = [[{ count: price, _tpl: currencyTpl }]];
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

            for (const containerId of containers as string[]) {
                const baseStats = (relativeProbabilities as any)[mapName]?.[containerId];
                if (!baseStats) {
                    this.log(Color.DEBUG, `No probability data for container ${containerId} on ${mapName}`);
                    continue;
                }

                const rarityWeight = (modConfig as any).rarity_weights[cfg.rarity];
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
     * Adds the item to ragfair (flea market) if tradeable on flea is enabled.
     * @param cfg Item configuration
     */
    private addToRagfair(cfg: typeof customItemConfigs[number]): void {
        // Check global config for flea trading
        const canTradeOnFlea = (modConfig as any).cards_tradeable_on_flea ?? false;

        if (!canTradeOnFlea) return;

        // Add to ragfair config - ensure the item can appear on flea market
        const ragfairConfig = this.db.ragfair;
        
        // Remove from dynamic blacklist if present
        if (ragfairConfig?.dynamic?.blacklist) {
            const blacklistIndex = ragfairConfig.dynamic.blacklist.findIndex((item: any) => item.tpl === cfg.id);
            if (blacklistIndex !== -1) {
                ragfairConfig.dynamic.blacklist.splice(blacklistIndex, 1);
                this.log(Color.DEBUG, `Removed ${cfg.item_short_name} from ragfair dynamic blacklist`);
            }
        }

        // Remove from static blacklist if present
        if (ragfairConfig?.static?.blacklist) {
            const staticBlacklistIndex = ragfairConfig.static.blacklist.findIndex((item: any) => item.tpl === cfg.id);
            if (staticBlacklistIndex !== -1) {
                ragfairConfig.static.blacklist.splice(staticBlacklistIndex, 1);
                this.log(Color.DEBUG, `Removed ${cfg.item_short_name} from ragfair static blacklist`);
            }
        }

        // Check if item's parent category is allowed on ragfair
        const parentId = cfg.item_parent || this.db.templates.items[cfg.clone_item]?._parent;
        if (parentId && ragfairConfig?.dynamic?.condition) {
            // Make sure parent category is not in blacklist by parent
            const conditionConfig = ragfairConfig.dynamic.condition;
            if (conditionConfig[parentId] !== undefined) {
                conditionConfig[parentId] = true; // Enable trading for this parent category
                this.log(Color.DEBUG, `Enabled ragfair trading for parent category ${parentId}`);
            }
        }

        this.log(Color.DEBUG, `Configured ${cfg.item_short_name} for ragfair trading`);
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
     * Extends pouch filters to accept the empty booster container.
     */
    private extendPouchFilters(): void {
        const itemsTable = this.db.templates.items;
        const emptyBoosterId = "68836790691c107f4fedc511"; // Empty booster ID
        
        // Specific secure container IDs
        const secureContainerIds = [
            "544a11ac4bdc2d470e8b456a", // Secure container Alpha
            "5857a8b324597729ab0a0e7d", // Secure container Beta
            "59db794186f77448bc595262", // Secure container Epsilon
            "5857a8bc2459772bad15db29", // Secure container Gamma
            "665ee77ccf2d642e98220bca", // Secure container Gamma (bis)
            "5c093ca986f7740a1867ab12", // Secure container Kappa
            "676008db84e242067d0dc4c9", // Secure container Kappa (Desecrated)
            "664a55d84a90fc2c8a6305c9", // Secure container Theta
            "5732ee6a24597719ae0c0281"   // Waist pouch
        ];
        
        let totalInserted = 0;

        // Process each specific secure container
        for (const containerId of secureContainerIds) {
            const container = itemsTable[containerId];
            if (!container) {
                this.log(Color.DEBUG, `Secure container ${containerId} not found in database`);
                continue;
            }
            
            // Check if this secure container has grids (storage space)
            if (!(container as any)._props?.Grids) {
                this.log(Color.DEBUG, `Secure container ${containerId} has no grids`);
                continue;
            }
            
            const grids = (container as any)._props.Grids;
            for (const grid of grids) {
                if (!grid._props?.filters) continue;
                
                // Add our empty booster to each filter
                for (const filter of grid._props.filters) {
                    if (filter.Filter && !filter.Filter.includes(emptyBoosterId)) {
                        filter.Filter.push(emptyBoosterId);
                        totalInserted++;
                        this.log(Color.DEBUG, `Added empty booster to ${(container as any)._props?.Name || containerId}`);
                    }
                }
            }
        }

        this.log(
            Color.INFO,
            totalInserted > 0
                ? `Empty Booster added to ${totalInserted} secure container filters`
                : "No secure container filters were modified"
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
        const containerProps = this.db.templates.items[containerBase.clone_item]._props;
        const side = 4;
        const allowedTpls = cards.map(c => c.id);

        emptyBooster._props = {
            ...containerProps,
            Name: emptyBooster.item_name,
            ShortName: emptyBooster.item_short_name,
            Description: emptyBooster.item_description,
            Prefab: { path: emptyBooster.item_prefab_path },
            BackgroundColor: emptyBooster.color,
            Width: emptyBooster.ExternalSize.width,
            Height: emptyBooster.ExternalSize.height,
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

        emptyBooster.item_parent = this.db.templates.items[containerBase.clone_item]._parent;
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
            if (["5448e53e4bdc2d60728b4567", "5448bf274bdc2dfc2f8b456a"].includes((item as any)._parent) && (item as any)._id !== "5c0a794586f77461c458f892") {
                if (!(item as any)._props.Grids[0]._props.filters) (item as any)._props.Grids[0]._props.filters = compat;
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

    /**
     * Validates that rarity weights sum to exactly 1.0
     * Throws an error and stops the mod if validation fails.
     */
    private validateRarityWeights(): void {
        const weights = (modConfig as any).rarity_weights;
        
        if (!weights || typeof weights !== 'object') {
            this.log(Color.ERROR, "rarity_weights object not found in mod_config.jsonc");
            throw new Error("[TTC] Configuration Error: rarity_weights object is missing or invalid");
        }

        const requiredRarities = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Secret"];
        const sum = requiredRarities.reduce((total, rarity) => {
            const weight = weights[rarity];
            if (typeof weight !== 'number') {
                this.log(Color.ERROR, `rarity_weights.${rarity} is not a number`);
                throw new Error(`[TTC] Configuration Error: rarity_weights.${rarity} must be a number`);
            }
            return total + weight;
        }, 0);

        const tolerance = 0;
        if (Math.abs(sum - 1.0) > tolerance) {
            this.log(Color.ERROR, `rarity_weights sum is ${sum.toFixed(6)} but must equal 1.0`);
            throw new Error(`[TTC] Configuration Error: rarity_weights must sum to exactly 1.0, got ${sum.toFixed(6)}`);
        }

        this.log(Color.INFO, `Rarity weights validation passed (sum: ${sum.toFixed(6)})`);
    }
}

module.exports = { mod: new TarkovTradingCards() };