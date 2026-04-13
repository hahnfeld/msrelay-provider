export { createRelayPlugin } from "./plugin.js";

/**
 * Default export is the plugin instance (not the factory).
 * OpenACP's plugin loader expects `default` to be an OpenACPPlugin object.
 */
import { createRelayPlugin } from "./plugin.js";
export default createRelayPlugin();
export { AzureRelayProvider } from "./provider.js";
export type { RelayMetrics } from "./provider.js";
export type { AzureRelayConfig } from "./types.js";
export { AzureRelayConfigSchema, DEFAULT_CONFIG } from "./types.js";
