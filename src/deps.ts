import type { GatewayConfig } from "./config";
import type { Store } from "./store/types";
import type { ConfigStore } from "./store/config";
import type { UpstreamRegistry } from "./upstream/registry";
import type { TrustService } from "./trust/service";
import type { HermesBridge } from "./hermes/bridge";

export interface Deps {
  config: GatewayConfig;
  store: Store;
  configStore: ConfigStore;
  registry: UpstreamRegistry;
  trust: TrustService;
  hermes: HermesBridge;
  callerId: string;
  groups: string[];
}
