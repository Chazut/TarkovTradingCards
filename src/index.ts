import { DependencyContainer } from "tsyringe";
import { IPreSptLoadMod, IPostDBLoadMod } from "@spt/models/external";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { DatabaseServer } from "@spt/servers/DatabaseServer";
import { ConfigServer } from "@spt/servers/ConfigServer";
import { JsonUtil } from "@spt/utils/JsonUtil";
import { ProfileHelper } from "@spt/helpers/ProfileHelper";

import { customItemConfigs } from "./item_configs";
import fs  from "fs";
import path from "path";
import JSON5 from "json5";

const cfgPath  = path.resolve(__dirname, "../config/mod_config.jsonc");
const modConfig = JSON5.parse(fs.readFileSync(cfgPath, "utf-8"));

let relativeProbabilities: Record<string, any> = {};
enum Color {
    INFO = "blue",
    DEBUG = "yellow",
    ERROR = "red"
}

const rarityOrder = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Secret"] as const;
type Rarity = typeof rarityOrder[number];

const rarityWeight: Record<Rarity, number> = Object.fromEntries(
    rarityOrder.map((r, idx) => [r, idx])
) as Record<Rarity, number>;

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
    private profileHelper!: ProfileHelper;
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
        this.container      = container;
        this.logger         = container.resolve<ILogger>("WinstonLogger");
        this.jsonUtil       = container.resolve<JsonUtil>("JsonUtil");
        this.profileHelper  = container.resolve<ProfileHelper>("ProfileHelper");

        const databaseServer   = container.resolve<DatabaseServer>("DatabaseServer");
        this.db                = databaseServer.getTables();

        const configServer     = container.resolve<ConfigServer>("ConfigServer");
        this.configInventory   = configServer.getConfigByString("spt-inventory");

        this.log(Color.INFO, "Initialisation");

        // --- Load current probabilities file --
        const probPath = path.resolve(__dirname, "../config/probabilities.json");
        if (fs.existsSync(probPath)) {
            relativeProbabilities = JSON.parse(fs.readFileSync(probPath, "utf-8"));
        }
        // --- Auto-update if option is enabled ---
        if ((modConfig as any).auto_update_probabilities) {
            const regenerated = this.generateProbabilities();
            // merge (keeps any exotic entries you may have added manually)
            relativeProbabilities = { ...relativeProbabilities, ...regenerated };
            fs.writeFileSync(probPath, JSON.stringify(relativeProbabilities, null, 2));
            this.log(Color.INFO, "probabilities.json auto-updated");
        }

        this.rarityCounts = {};
        for (const card of customItemConfigs) {
            this.rarityCounts[card.rarity] = (this.rarityCounts[card.rarity] || 0) + 1;
        }

        for (const card of customItemConfigs) {
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

        // --------------------------------------------------------------
        // Build Collector Album and append to array --------------------
        // --------------------------------------------------------------
        const album = this.buildCollectorAlbum(customItemConfigs);
        customItemConfigs.push(album);
    }

    private injectCard(cfg: typeof customItemConfigs[number]): void {
        this.ensureCompatFilters();
        this.db.templates.items[cfg.id] = this.buildTemplate(cfg);
        this.addLocales(cfg);
        this.addHandbookEntry(cfg);
        this.addToTrader(cfg);
        this.addToLoot(cfg);
    }

    private injectContainer(cfg: typeof customItemConfigs[number]): void {
        this.ensureCompatFilters();
        this.db.templates.items[cfg.id] = this.buildTemplate(cfg);
        this.addLocales(cfg);
        this.addHandbookEntry(cfg);
        this.addToTrader(cfg);
    }

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

    private addLocales(cfg: typeof customItemConfigs[number]): void {
        for (const locale of Object.values(this.db.locales.global) as Record<string, string>[]) {
            locale[`${cfg.id} Name`] = cfg.item_name;
            locale[`${cfg.id} ShortName`] = cfg.item_short_name;
            locale[`${cfg.id} Description`] = cfg.item_description;
        }
    }

    private addHandbookEntry(cfg: typeof customItemConfigs[number]): void {
        this.db.templates.handbook.Items.push({ Id: cfg.id, ParentId: cfg.category_id, Price: cfg.price });
    }

    private addToTrader(cfg: typeof customItemConfigs[number]): void {
        if (!cfg.sold) return;
        const trader = this.db.traders[cfg.trader] ?? this.db.traders[modConfig.fallback_trader];
        if (!trader) return this.log(Color.DEBUG, `Trader ${cfg.trader} not found for ${cfg.item_short_name}`);
        trader.assort.items.push({ _id: cfg.id, _tpl: cfg.id, parentId: "hideout", slotId: "hideout", upd: { UnlimitedCount: cfg.unlimited_stock, StackObjectsCount: cfg.stock_amount } });
        trader.assort.barter_scheme[cfg.id] = [[{ count: cfg.price, _tpl: cfg.currency }]];
		const currencyTpl = this.currencyMap[cfg.currency] ?? cfg.currency;
        trader.assort.barter_scheme[cfg.id] = [
            [{ count: cfg.price, _tpl: currencyTpl }]
        ];
        trader.assort.barter_scheme[cfg.id] = [[{ count: cfg.price, _tpl: currencyTpl }]];
        trader.assort.loyal_level_items[cfg.id] = cfg.trader_loyalty_level;
    }

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
                const globalMult = userMult * 0.2
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

    /** Scan every map/container and build fresh probability stats. */
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
     * Allow every TTC card inside specific containers
     * – S I C C case and DOC case for now.
     */
    private extendCardStorageCases(): void
    {
        const itemsTable = this.db.templates.items;

        // Target case template IDs
        const targetCases = [
            "5d235bb686f77443f4331278", // S I C C
            "590c60fc86f77412b13fddcf"  // DOC
        ];

        // All card template IDs
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

    // ------------------------------------------------------------------
    /** Build the single Collector Album template at runtime (needs DB templates) */
    private buildCollectorAlbum(cards: any[]): any {
        const albumBase = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, "../config/album_base.json"), "utf-8")
        );
        const albumOverride = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, "../config/containers/ttc_booster_pack.json"), "utf-8")
        );

        const album = { ...albumBase, ...albumOverride };
        const mountProps = this.db.templates.items[albumBase.clone_item]._props;
        const genId = () => (Date.now().toString(16) + Math.random().toString(16)).slice(0, 24);
        const side = 10;  

        album._props = {
            ...mountProps,
            Width: 1,
            Height: 1,
            Slots: cards
                .slice()
                .sort(sortByRarity)
                .map(c => ({
                    _id: genId(),
                    _name: `mod_mount_${c.id}`,
                    _parent: album.id,
                    _type: "Slot",
                    _props: {
                        filters: [{
                            Filter: [c.id],
                            ExcludedFilter: []
                        }],
                        required: false,
                        max_count: 1,
                        iconId: "mount"
                    }
                }))
        };

        this.injectContainer(album);

        this.log(Color.INFO, `Collector Album built successfully with ${cards.length} cards`);

        return album;
    }

    private ensureCompatFilters(): void {
        const compat = [{ Filter: ["54009119af1c881c07000029"], ExcludedFilter: [""] }];
        for (const item of Object.values(this.db.templates.items)) {
            if (["5448e53e4bdc2d60728b4567", "5448bf274bdc2dfc2f8b456a"].includes(item._parent) && item._id !== "5c0a794586f77461c458f892") {
                if (!item._props.Grids[0]._props.filters) item._props.Grids[0]._props.filters = compat;
            }
        }
    }

    private log(color: Color, msg: string): void {
        if (color === Color.DEBUG && !this.debug) return;
        this.logger.log(`[${this.modName}] ${msg}`, color);
    }
}

module.exports = { mod: new TarkovTradingCards() };
