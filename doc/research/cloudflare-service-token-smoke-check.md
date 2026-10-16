# Cloudflare service-token production smoke check

Researched 2026-10-15 against first-party documentation and the checked-out repo. No infrastructure, credentials, or application code were changed; no live authentication was attempted.

## Recommendation

Use an authenticated **public HTTPS `GET /recipes`**, not JWT extraction followed by direct Lambda invocation. Give GitHub Actions a dedicated, expiring Access service token and add a separate **Service Auth** policy matching only that token. Keep the existing owner-email Allow policy. Send `CF-Access-Client-Id` and `CF-Access-Client-Secret` on each request. Cloudflare authenticates the credentials and injects the signed application JWT into the origin request; the runner does not need to obtain that JWT. [1][2][3]

This exercises Access, DNS/TLS, API Gateway, Lambda authentication, and the DB read together. In this repo `/recipes` calls `recipes.list()`, Lambda constructs the DB-backed recipes implementation, and production config selects `DATABASE_DRIVER = "data-api"`; `/health` does not exercise that read and skips application authentication. [R2][R3][R4] Require **HTTP 200 plus JSON with a `recipes` array**; do not follow login redirects, accept an HTML login page as success, or require a nonempty database. Do not print credentials, JWTs, verbose request headers, or recipe contents in CI logs. These are implementation recommendations, not a live-tested workflow.

**Least-privilege caveat:** adding the policy to the current shared web/API application authorizes the token for both destinations. The API currently authorizes every authenticated identity equally, including `POST /recipes`; a GET-only smoke command does **not** make its credential read-only. If a genuinely read-only credential is required, design explicit API authorization or a more narrowly scoped Access application and audience handling. Do not describe the simple shared-app token as read-only. [R1][R2]

## Can the runner obtain a JWT instead?

| Mechanism                                  | Verified conclusion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service-token headers to the protected URL | Supported authentication path. The Client ID/Secret are credentials, **not** the signed JWT accepted by this API. Cloudflare adds `Cf-Access-Jwt-Assertion` to the request sent to the origin. It is not documented as a client response header; inspecting an ordinary authenticated response does not give the runner that upstream header. [1][2]                                                                                                                                                                                                                                                                                  |
| `CF_Authorization` response cookie         | **Not a durable design.** Current strict service-token authentication explicitly returns no such cookie after successful authentication. Strict mode is mandatory for organizations created on/after 2026-10-05 and recommended for older organizations. It also ignores Allow policies and any supplied authorization cookie on service-token requests. [1] The API describes this as successful requests “no longer” receiving the cookie, confirming older behavior, but the existing organization's setting and exact legacy cookie behavior were not inspected. [6] Do not disable strict auth merely to extract a bearer token. |
| `/cdn-cgi/access/get-identity`             | Documented as taking an **existing** `CF_Authorization` cookie and returning identity JSON, not as a service-credential-to-JWT exchange. The response fields include `service_token_id`/`service_token_status`; that does not establish a token-minting API. [3]                                                                                                                                                                                                                                                                                                                                                                      |
| Cloudflare management API                  | Creating a service token returns `client_id` and `client_secret`, not an Access application JWT. Management requires a separate Cloudflare API token with `Access: Service Tokens Write`. This permission is unnecessary for the smoke request itself. [1][7]                                                                                                                                                                                                                                                                                                                                                                         |
| OAuth `client_credentials` exchange        | No documented exchange for a **self-hosted Access service token** was found in the reviewed official sources. Do not confuse service-token credentials with an OIDC SaaS application's OAuth credentials or assume a `/token` endpoint exists for this purpose. This is a research limitation, not proof no other Cloudflare product offers OAuth. [1][3][7]                                                                                                                                                                                                                                                                          |

If direct AWS invocation is non-negotiable, it still needs an actual signed application JWT in the simulated API Gateway event's `cf-access-jwt-assertion` header, plus separate AWS invocation authorization. Sending service-token headers directly to Lambda cannot work with the current provider: it reads only the assertion header and does not exchange credentials. [R5] No simple, strict-mode-compatible runner-side JWT retrieval endpoint was verified. Avoid adding a production JWT-echo endpoint just to support a smoke check; authenticated public HTTP is simpler and avoids exporting the origin bearer token.

## Service JWT compatibility: the empty `sub` detail

Cloudflare explicitly documents this service-token application payload shape: [3]

```json
{
  "type": "app",
  "aud": ["<application-audience>"],
  "iss": "https://<team>.cloudflareaccess.com",
  "common_name": "<service-client-id>.access",
  "sub": "",
  "iat": 1659474397,
  "exp": 1659474457
}
```

- `common_name` is the service token's **Client ID**, not its display name or Terraform resource UUID. `sub` is an **empty string**, not a missing claim. [3]
- The current `cloudflareAuthProvider` verifies signature, issuer, and application audience using remote JWKS, then checks only `typeof payload.sub === 'string'`. Therefore the documented service JWT **passes that condition** and produces `subject: ''`; missing email is already allowed. It is incorrect to claim current auth necessarily rejects service tokens. This is static source analysis, not a live-token test. [R5]
- That is sufficient for current `/recipes`, which checks only for a returned identity. It is not a good durable machine-identity model: all service tokens collapse to an empty subject. If identity/auditing/authorization is extended, explicitly distinguish verified human subjects from service principals based on verified `common_name`, with namespacing and intended-token authorization rather than inventing an owner email or loosening JWT checks. [R2][R5] Recommendation only; no code change made.

## Terraform: use the pinned v4 schema

The prod lock file pins Cloudflare **4.52.8**; the prod version constraint is `~> 4.52`. The tagged provider schema accepts `allow`, `deny`, **`non_identity`**, and `bypass`—**not `service_auth`**. Service Auth is represented by `decision = "non_identity"`. [R6][R7][4][8]

The v4.52.8 configuration shape, for a future implementation, is:

```hcl
resource "cloudflare_zero_trust_access_service_token" "smoke" {
  account_id = var.cloudflare_account_id
  name       = "${var.name_prefix}-github-smoke"
  duration   = "8760h"
}

resource "cloudflare_zero_trust_access_policy" "smoke" {
  account_id = var.cloudflare_account_id
  name       = "${var.name_prefix}-github-smoke"
  decision   = "non_identity"

  include {
    service_token = [cloudflare_zero_trust_access_service_token.smoke.id]
  }
}
```

Attach the new policy ID alongside `web_owner.id` in the existing application's `policies` list. Do not replace the human policy, use `any_valid_service_token`, or copy the latest provider's object/list syntax into v4. The selector uses the **resource UUID** (`.id`); CI authentication uses `.client_id` and `.client_secret`. The tagged v4 token resource marks the secret sensitive and exposes it as a computed attribute; protect Terraform state as secret material if Terraform manages it. The docs warn that an imported token will not provide its secret, which is only available at creation. [4][5][R1] Provisioning, GitHub secret setup, rotation, and state handling require a separate authorized implementation task.

## Sources

1. [Cloudflare: service tokens, request headers, strict service-token authentication](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
2. [Cloudflare: validate JWTs; origin request assertion header and remote signing keys](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
3. [Cloudflare: application token; service payload and get-identity](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
4. [Cloudflare provider v4.52.8: policy resource documentation](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v4.52.8/docs/resources/zero_trust_access_policy.md) and [schema validation source](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v4.52.8/internal/sdkv2provider/schema_cloudflare_access_policy.go)
5. [Cloudflare provider v4.52.8: service token resource](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v4.52.8/docs/resources/zero_trust_access_service_token.md)
6. [Cloudflare API: organization update; strict_service_token_auth](https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/update/)
7. [Cloudflare API: create a service token](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/methods/create/)
8. [Cloudflare: service-token enrollment example maps Service Auth to non_identity](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/deployment/device-enrollment/#check-for-service-token)

Repo sources (relative to repo root):

- R1: `infra/terraform/modules/app_environment/cloudflare.tf:82-110` — owner policy, shared application, destinations.
- R2: `packages/api/src/app.ts:34-65` — authentication, GET and POST behavior.
- R3: `packages/api/src/lambda.ts:9-17` — DB-backed Lambda handler.
- R4: `infra/terraform/modules/app_environment/api.tf:65-75` — production Access and Data API environment.
- R5: `packages/api/src/auth/cloudflareAuthProvider.ts:4-37` — assertion-only verification and string-sub test.
- R6: `infra/terraform/prod/.terraform.lock.hcl:4-6` — exact provider version.
- R7: `infra/terraform/prod/versions.tf:22-25` — provider constraint.
