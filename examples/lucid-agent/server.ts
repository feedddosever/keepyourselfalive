import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
import { createAgentApp } from "@lucid-agents/hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { McpKeeperHubClient } from "../../src/adapters/mcp.js";
import { LucidKeeperHubSettler } from "../../src/lucid/settlement.js";
import type { KeeperHubClient } from "../../src/keeperhub.js";
import type { SettlementRequest } from "../../src/lucid/types.js";

/**
 * A real Lucid Agents service whose paid entrypoint settles through KeeperHub.
 *
 * Built on Lucid's published packages (`@lucid-agents/core`, `/http`, `/hono`) —
 * this is their runtime serving their agent card and their entrypoint, not a
 * reimplementation of it.
 *
 * The seam: Lucid requires an x402 buyer's payment identifier to equal the HTTP
 * `Idempotency-Key`. That same header is used verbatim as KeeperHub's
 * `idempotency_key`, so the value the buyer retries with is the value that
 * decides whether a transfer is broadcast or replayed.
 */

const PORT = Number(process.env.PORT ?? 3000);
const SELLER = process.env.PAY_TO ?? "0x000000000000000000000000000000000000bEEF";
const PRICE_ETH = process.env.PRICE_ETH ?? "0.0000001";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 84532);

function settler(): LucidKeeperHubSettler {
  const apiKey = process.env.KH_API_KEY ?? process.env.KEEPERHUB_API_KEY;
  if (!apiKey) {
    throw new Error("KH_API_KEY is not set; the entrypoint cannot settle without it");
  }
  const client: KeeperHubClient = new McpKeeperHubClient({ apiKey });
  return new LucidKeeperHubSettler(client);
}

const agent = await createAgent({
  name: "summarizer",
  version: "1.0.0",
  description: "A paid Lucid entrypoint that settles on a verified onchain receipt.",
})
  .use(http())
  .addEntrypoint({
    key: "summarize",
    description: "Summarize text. Settles through KeeperHub before returning.",
    input: z.object({ text: z.string().min(1) }),
    output: z.object({
      summary: z.string(),
      settlement: z.object({
        paymentIdentifier: z.string(),
        txHash: z.string(),
        txLink: z.string().optional(),
        blockNumber: z.number().optional(),
        replayed: z.boolean(),
      }),
    }),
    handler: async ({ input, metadata }) => {
      // Lucid's HTTP extension puts the request headers here, and validates
      // Idempotency-Key at 20-256 characters before the handler ever runs.
      // Its x402 reconciliation forces the payment identifier to equal this
      // header, so it is the buyer's own retry token — exactly what an
      // idempotency key must be.
      const headers = (metadata as { headers?: Headers } | undefined)?.headers;
      const paymentIdentifier = headers?.get("Idempotency-Key") ?? undefined;

      const settlementRequest: SettlementRequest = {
        reconciliation: {
          ...(paymentIdentifier ? { paymentIdentifier } : {}),
          extensions: {},
        },
        entrypointKey: "summarize",
        kind: "invoke",
        chainId: CHAIN_ID,
        payTo: SELLER,
        amount: PRICE_ETH,
      };

      // Settle first. Fulfilment is irreversible, so it must not happen before
      // the money has provably moved.
      const settlement = await settler().settle(settlementRequest);

      const text = (input as { text: string }).text;
      return {
        output: {
          summary: text.length > 80 ? `${text.slice(0, 77)}...` : text,
          settlement: {
            paymentIdentifier: settlement.paymentIdentifier,
            txHash: settlement.txHash,
            ...(settlement.txLink ? { txLink: settlement.txLink } : {}),
            ...(settlement.blockNumber === undefined ? {} : { blockNumber: settlement.blockNumber }),
            replayed: settlement.replayed,
          },
        },
        // Lucid's own settlement record. `reference` is documented as a
        // "verified payment channel or session reference" — so the onchain
        // transaction hash goes here, and Lucid's accounting ends up pointing
        // at a receipt that was reconciled against the chain.
        payment: {
          actualAmount: PRICE_ETH,
          asset: "ETH",
          reference: settlement.txHash,
        },
      };
    },
  })
  .build();

const { app } = await createAgentApp(agent);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`lucid agent listening on http://localhost:${info.port}`);
  console.log(`  agent card   GET  /.well-known/agent-card.json`);
  console.log(`  entrypoint   POST /entrypoints/summarize/invoke`);
  console.log(`  settles      ${PRICE_ETH} ETH → ${SELLER} on chain ${CHAIN_ID}`);
});
