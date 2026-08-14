# AWS Alternative — Migration Path

> Documented equivalent of the Cloudflare deployment, for when/if the gateway is run on AWS.
> Core logic (policy engine, Guard 1, Guard 2, upstream proxy) is provider-agnostic and lives
> in `src/` behind the `Store` interface in `src/store/types.ts`. Only the store driver,
> HTTP entrypoint, and secret plumbing differ.

## Architecture

```
opencode ──► Lambda Function URL (RESPONSE_STREAM)
                │  auth: IAM or simple API-key header
                ▼
        Lambda (Node.js, @modelcontextprotocol/sdk)
        ├── Guard 1 → DynamoDB audit table
        ├── Guard 2 → DynamoDB approvals table + Discord card
        └── forward → NanoKVM (secrets from AWS Secrets Manager)
```

## Why Lambda Function URLs, not API Gateway

- API Gateway **buffers** responses and does not forward chunked streaming; Lambda response
  streaming requires Function URLs (or `InvokeWithResponseStream`).
- API Gateway REST free tier (1M calls/mo) is a **12-month** offer only; Function URLs carry
  no per-call charge and are permanently free alongside Lambda.
- Function URL supports `RESPONSE_STREAM` invoke mode for SSE / screenshot passthrough.

## Service mapping (Cloudflare → AWS)

| Cloudflare | AWS |
|---|---|
| Worker (stateless) | Lambda + Function URL |
| D1 `audit` / `approvals` | DynamoDB tables (on-demand, 25GB free) |
| Workers Secrets | AWS Secrets Manager (or Lambda env + KMS) |
| Cloudflare Access front door | Function URL auth: IAM / API-key header |
| Discord interactions `POST /discord` | Same Function URL route |

## Implementation delta

1. Store driver: `src/store/dynamodb.ts` (implement `Store` interface).
2. Entrypoint: wrap the same handler logic in the Lambda runtime (`awslabs/mcp-lambda-handler`
   or Lambda Web Adapter + `RESPONSE_STREAM`).
3. Secrets: read from Secrets Manager at cold-start, cache in env.
4. Deploy: SAM or CDK template.

## AWS cost notes (monthly, within free tier)

| Item | Cost |
|---|---|
| Lambda | **$0** — always-free: 1M req + 400k GB-s/mo |
| DynamoDB | **$0** — 25GB, 25RCU/25WCU (provisioned) or 2.5M/1M on-demand |
| Function URL | **$0** |
| Discord | $0 |
| Overage | ~$0.20/M Lambda req; DDB on-demand pennies |

## Trade-offs vs Cloudflare

- **+** Larger compute ceiling per invocation (Lambda 15 min vs Workers Free 10ms CPU).
- **−** 1–3s cold starts on every cold Lambda.
- **−** More moving parts (Function URL + Lambda + DDB + SAM/CDK) vs a single Worker.
- **−** No reuse of the existing Cloudflare Access / tunnel auth.
