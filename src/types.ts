import { z } from "zod";

export interface AzureRelayConfig {
  /** Whether the provider is active. Default: true. */
  enabled: boolean;
  /** Local port to forward requests to. Default: PORT env var or 3978. */
  port: number | null;
  /** Azure resource group (saved for wizard pre-fill, not used at runtime). */
  resourceGroup?: string;
  /** Azure Relay namespace (e.g., "myrelay.servicebus.windows.net"). */
  relayNamespace: string;
  /** Hybrid Connection name (e.g., "bot-endpoint"). */
  hybridConnectionName: string;
  /** SAS policy name (e.g., "ListenOnly" or "RootManageSharedAccessKey"). */
  sasKeyName: string;
  /** SAS key value. Stored encrypted at rest by OpenACP settings. */
  sasKeyValue: string;
}

export const AzureRelayConfigSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().int().min(1).max(65535).nullable().default(null),
  relayNamespace: z.string().min(1).regex(
    /^[a-zA-Z0-9-]+\.servicebus\.windows\.net$/,
    "Must be a valid Azure Relay namespace (e.g., myrelay.servicebus.windows.net)",
  ),
  hybridConnectionName: z.string().min(1).regex(
    /^[a-zA-Z0-9._-]+$/,
    "Must contain only alphanumeric characters, dots, underscores, and hyphens",
  ),
  sasKeyName: z.string().min(1),
  sasKeyValue: z.string().min(1),
});

export const DEFAULT_CONFIG: AzureRelayConfig = {
  enabled: true,
  port: Number(process.env.PORT) || 3978,
  relayNamespace: "",
  hybridConnectionName: "",
  sasKeyName: "",
  sasKeyValue: "",
};
