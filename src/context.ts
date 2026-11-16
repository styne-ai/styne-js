import type { Client } from "./_generated/client";

/** What every resource needs to talk to the API. */
export interface Context {
  client: Client;
  fetch: typeof fetch;
  baseUrl: string;
}
