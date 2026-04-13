declare module "hyco-https" {
  import type { IncomingMessage, ServerResponse } from "node:http";
  import type { EventEmitter } from "node:events";

  interface RelayedServerOptions {
    server: string;
    token: () => string;
  }

  type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

  interface RelayedServer extends EventEmitter {
    listen(): void;
    close(callback?: () => void): void;
  }

  function createRelayedServer(
    options: RelayedServerOptions,
    requestListener: RequestListener,
  ): RelayedServer;

  function createRelayListenUri(namespace: string, path: string): string;

  function createRelayToken(
    uri: string,
    keyName: string,
    key: string,
    expirationSeconds?: number,
  ): string;
}
