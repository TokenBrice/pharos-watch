"use client";

import { CoinInsightPanel, type CoinInsightPanelProps } from "./CoinInsightPanel";
import { PresetsPanel, type PresetsPanelProps } from "./PresetsPanel";
import { SettingsPanel, type SettingsPanelProps } from "./SettingsPanel";
import { StatusPanel, type StatusPanelProps } from "./StatusPanel";
import { WatchlistPanel, type WatchlistPanelProps } from "./WatchlistPanel";
import type { ViewKey } from "../use-mini-app-view";

interface MiniAppPanelRouterProps {
  view: ViewKey;
  home: StatusPanelProps;
  watchlist: WatchlistPanelProps;
  presets: PresetsPanelProps;
  settings: SettingsPanelProps;
  coinInsight: CoinInsightPanelProps | null;
}

export function MiniAppPanelRouter({ view, home, watchlist, presets, settings, coinInsight }: MiniAppPanelRouterProps) {
  switch (view) {
    case "home":
      return (
        <section role="tabpanel" id="pharos-mini-app-panel-home" aria-labelledby="pharos-mini-app-tab-home">
          <StatusPanel {...home} />
        </section>
      );
    case "watchlist":
      return (
        <section role="tabpanel" id="pharos-mini-app-panel-watchlist" aria-labelledby="pharos-mini-app-tab-watchlist">
          {coinInsight ? (
            <div className="mb-4">
              <CoinInsightPanel {...coinInsight} />
            </div>
          ) : null}
          <WatchlistPanel {...watchlist} />
        </section>
      );
    case "presets":
      return (
        <section role="tabpanel" id="pharos-mini-app-panel-presets" aria-labelledby="pharos-mini-app-tab-presets">
          <PresetsPanel {...presets} />
        </section>
      );
    case "settings":
      return (
        <section role="tabpanel" id="pharos-mini-app-panel-settings" aria-labelledby="pharos-mini-app-tab-settings">
          <SettingsPanel {...settings} />
        </section>
      );
  }
}
