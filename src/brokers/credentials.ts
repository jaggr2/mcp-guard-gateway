import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { HermesBridge } from "../hermes/bridge";
import { extractBearerOrApiKey, resolveCallerProject } from "../llm/proxy";
import type { SecretBox } from "../secrets";
import type { ConfigStore } from "../store/config";
import type { Store } from "../store/types";

/**
 * Zero-Secret Credential Brokers for OpenCode Sandboxes:
 *
 * 1. `GET /aws-creds`: Native `AWS_CONTAINER_CREDENTIALS_FULL_URI` endpoint.
 *    - Read/diff mode (`?mode=read` or default): mints short-lived STS credentials
 *      for the project's `awsRoleArn` via `aws_signing_helper` (IAM Roles Anywhere).
 *    - Deploy/write mode (`?mode=deploy` or header `x-warden-aws-mode: deploy`):
 *      requires an active approved `aws_cdk_deploy:<slug>` HITL approval within a 30m TTL.
 *      If none exists, automatically creates a pending HITL approval and notifies Home Assistant!
 *
 * 2. `GET /git-creds`: Git HTTPS credential helper endpoint.
 *    - Validates the sandbox's `SANDBOX_TOKEN` and returns a GitHub token scoped to `jaggr2/<project>`.
 */

export async function handleAwsCredsBroker(
  request: Request,
  configStore: ConfigStore,
  store: Store,
  secrets: SecretBox,
  notifier: HermesBridge
): Promise<Response> {
  const token = extractBearerOrApiKey(request) ?? request.headers.get("Authorization")?.trim() ?? null;
  const project = resolveCallerProject(configStore, token);
  if (!project) {
    return Response.json({ message: "Unauthorized sandbox token" }, { status: 401 });
  }

  configStore.touchProjectActivity(project.slug);
  const url = new URL(request.url);
  const mode = (url.searchParams.get("mode") ?? request.headers.get("x-warden-aws-mode") ?? "read").toLowerCase();

  if (mode === "deploy") {
    const toolKey = `aws_cdk_deploy:${project.slug}`;
    const approvals = await store.listApprovals("approved");
    const nowIso = new Date().toISOString();
    const active = approvals.find(
      (a) => a.tool === toolKey && (!a.expires_at || a.expires_at > nowIso)
    );

    if (!active) {
      const pendingList = await store.listApprovals("pending");
      let pending = pendingList.find((a) => a.tool === toolKey);
      if (!pending) {
        const approvalId = `apr_${randomUUID().slice(0, 12)}`;
        const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
        await store.createApproval({
          id: approvalId,
          tool: toolKey,
          args: JSON.stringify({ project: project.slug, role: project.awsDeployRoleArn ?? project.awsRoleArn }),
          reason: `Elevate sandbox '${project.slug}' to AWS CDK deploy permissions (30m TTL)`,
          status: "pending",
          timeout_action: "deny",
          ttl_minutes: 30,
          created_at: nowIso,
          expires_at: expiresAt,
        });
        await notifier.sendApprovalCard(
          toolKey,
          `Sandbox '${project.slug}' requested AWS CDK deploy credentials`,
          { project: project.slug, mode: "deploy" },
          approvalId
        );
        pending = await store.getApproval(approvalId) ?? undefined;
      }

      return Response.json(
        {
          code: "ApprovalPending",
          message: `[Warden HITL Guard] AWS CDK deploy for '${project.slug}' requires approval (ID: ${pending?.id}). Approve via Home Assistant or warden.jaggi.xyz/approvals.`,
          approval_id: pending?.id,
        },
        { status: 403 }
      );
    }
  }

  const roleArn = mode === "deploy" ? (project.awsDeployRoleArn ?? project.awsRoleArn) : project.awsRoleArn;

  // Check if static/test STS secret is stored for this project in Warden secrets
  const secretCipher =
    configStore.getSecret(`AWS_CREDS_${project.slug.toUpperCase().replace(/-/g, "_")}`) ??
    configStore.getSecret("AWS_SANDBOX_DEFAULT_CREDS");
  if (secretCipher) {
    try {
      const parsed = JSON.parse(secrets.decrypt(secretCipher)) as {
        AccessKeyId: string;
        SecretAccessKey: string;
        Token?: string;
        Expiration?: string;
      };
      return Response.json({
        AccessKeyId: parsed.AccessKeyId,
        SecretAccessKey: parsed.SecretAccessKey,
        Token: parsed.Token ?? "",
        Expiration: parsed.Expiration ?? new Date(Date.now() + 3600_000).toISOString(),
      });
    } catch {
      /* fall through to Roles Anywhere */
    }
  }

  // Invoke aws_signing_helper (IAM Roles Anywhere) when configured
  const trustAnchorArn = configStore.getSetting("aws.trustAnchorArn") ?? process.env.AWS_TRUST_ANCHOR_ARN;
  const profileArn = configStore.getSetting("aws.profileArn") ?? process.env.AWS_PROFILE_ARN;
  const certPath = configStore.getSetting("aws.certPath") ?? "/home/roger/.aws/roles-anywhere/client.crt";
  const keyPath = configStore.getSetting("aws.keyPath") ?? "/home/roger/.aws/roles-anywhere/client.key";

  if (roleArn && trustAnchorArn && profileArn) {
    try {
      const out = execFileSync(
        "/usr/local/bin/aws_signing_helper",
        [
          "credential-process",
          "--certificate",
          certPath,
          "--private-key",
          keyPath,
          "--trust-anchor-arn",
          trustAnchorArn,
          "--profile-arn",
          profileArn,
          "--role-arn",
          roleArn,
        ],
        { encoding: "utf8", timeout: 10_000 }
      );
      return new Response(out, { headers: { "Content-Type": "application/json" } });
    } catch (err) {
      return Response.json(
        { message: `Roles Anywhere credential-process failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 }
      );
    }
  }

  return Response.json(
    {
      message: `No AWS Role ARN configured for project '${project.slug}'. Set awsRoleArn in Warden Sandboxes UI.`,
    },
    { status: 404 }
  );
}

export async function handleGitCredsBroker(
  request: Request,
  configStore: ConfigStore,
  secrets: SecretBox
): Promise<Response> {
  const token = extractBearerOrApiKey(request);
  const project = resolveCallerProject(configStore, token);
  if (!project) {
    return Response.json({ error: "Unauthorized sandbox token" }, { status: 401 });
  }

  configStore.touchProjectActivity(project.slug);

  // Project-specific token first, then fallback to GITHUB_SANDBOX_TOKEN
  const projSecretName = `GITHUB_TOKEN_${project.slug.toUpperCase().replace(/-/g, "_")}`;
  const cipher = configStore.getSecret(projSecretName) ?? configStore.getSecret("GITHUB_SANDBOX_TOKEN");
  let ghToken: string | null = null;
  if (cipher) {
    try {
      ghToken = secrets.decrypt(cipher);
    } catch {
      ghToken = null;
    }
  }
  if (!ghToken) {
    ghToken = process.env.GITHUB_SANDBOX_TOKEN ?? process.env.GITHUB_TOKEN ?? null;
  }
  if (!ghToken) {
    return Response.json({ error: "No GitHub token configured in Warden secrets" }, { status: 404 });
  }

  return Response.json({
    project: project.slug,
    repo: `jaggr2/${project.slug}`,
    token: ghToken,
  });
}
