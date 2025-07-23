import { DependencyContainer } from "tsyringe";
import { IPreSptLoadMod, IPostDBLoadMod } from "@spt/models/external";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { DatabaseServer } from "@spt/servers/DatabaseServer";
import { ConfigServer } from "@spt/servers/ConfigServer";
import { JsonUtil } from "@spt/utils/JsonUtil";
import { ProfileHelper } from "@spt/helpers/ProfileHelper";

import { customItemConfigs } from "./item_configs";
import * as modConfig from "../config/mod_config.json";
import * as relativeProbabilities from "../config/probabilities.json";

interface RarityCounter { [rarity: string]: number }

enum Color {
    INFO = "blue",
    DEBUG = "yellow",
    ERROR = "red"
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
        this.profileHelper = container.resolve<ProfileHelper>("ProfileHelper");
        const databaseServer = container.resolve<DatabaseServer>("DatabaseServer");
        this.db = databaseServer.getTables();
        const configServer = container.resolve<ConfigServer>("ConfigServer");
        this.configInventory = configServer.getConfigByString("spt-inventory");

        this.log(Color.INFO, "Initialisation");

        const rarityCounter: RarityCounter = {};

        for (const card of customItemConfigs) {
			try {
				this.injectCard(card);
				rarityCounter[card.rarity] = (rarityCounter[card.rarity] || 0) + 1;
			} catch (e) {
				this.log(Color.ERROR, `Failed to inject ${card.item_short_name}: ${(e as Error).message}`);
			}
		}

		Object.entries(rarityCounter).forEach(([r, c]) =>
			this.log(Color.INFO, `→ ${r}: ${c} card(s) loaded.`)
		);
    }

    private injectCard(cfg: typeof customItemConfigs[number]): void {
        this.ensureCompatFilters();
        this.db.templates.items[cfg.id] = this.buildTemplate(cfg);
        this.addLocales(cfg);
        this.addHandbookEntry(cfg);
        this.addToTrader(cfg);
        this.addToLoot(cfg);
    }

    private buildTemplate(cfg: typeof customItemConfigs[number]): any {
        const base = this.jsonUtil.clone(this.db.templates.items[cfg.clone_item]);
        return Object.assign(base, {
            _id: cfg.id,
            _name: cfg.item_name,
            _parent: cfg.item_parent,
            _props: {
                ...base._props,
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
            }
        });
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
        for (const [mapName, containers] of Object.entries(cfg.loot_locations)) {
            const map = this.db.locations[mapName];
            if (!map) {
                this.log(Color.DEBUG, `Map '${mapName}' not found when adding ${cfg.item_short_name}`);
                continue;
            }
            for (const containerId of containers) {
                const baseStats = relativeProbabilities[mapName]?.[containerId];
                if (!baseStats) {
                    this.log(Color.DEBUG, `No probability data for container ${containerId} on ${mapName}`);
                    continue;
                }
                const relProb = Math.ceil(baseStats.max_found * modConfig[cfg.rarity]);
                map.staticLoot[containerId] ??= { itemDistribution: [] } as any;
                map.staticLoot[containerId].itemDistribution.push({ tpl: cfg.id, relativeProbability: relProb });
                this.log(Color.DEBUG, `Added ${cfg.item_short_name} to ${mapName}/${containerId} (prob=${relProb})`);
            }
        }
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
