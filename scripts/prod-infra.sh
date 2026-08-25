#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="$ROOT_DIR/infra/terraform/prod"
PLAN_FILE="$TF_DIR/prod.tfplan"
PLAN_TEXT="$TF_DIR/prod-plan.txt"
PLAN_JSON="$TF_DIR/prod-plan.json"
REPORT_FILE="$TF_DIR/prod-report.txt"
BACKEND_BUCKET="recipes-terraform-state-699281550169"
AWS_PROFILE_NAME="${TF_VAR_aws_profile:-recipes-admin}"
AWS_REGION_NAME="${TF_VAR_aws_region:-us-east-1}"
WEB_HOSTNAME="recipes.rkac.dev"
API_HOSTNAME="recipes-api.rkac.dev"

export TF_VAR_aws_profile="$AWS_PROFILE_NAME"
export TF_VAR_aws_region="$AWS_REGION_NAME"

usage() {
  printf 'Usage: %s {preflight|plan|inspect-plan|report}\n' "$0" >&2
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

require_env() {
  if [ -z "${!1:-}" ]; then
    printf 'Missing required environment variable: %s\n' "$1" >&2
    exit 1
  fi
  printf 'env:%s=present\n' "$1"
}

terraform_init() {
  terraform -chdir="$TF_DIR" init \
    -backend-config="bucket=$BACKEND_BUCKET" \
    -backend-config="profile=$AWS_PROFILE_NAME" \
    -input=false
}

preflight() {
  require_command terraform
  require_command aws
  require_command curl
  require_command node
  require_command dig
  require_env CLOUDFLARE_API_TOKEN
  require_env TF_VAR_cloudflare_account_id
  require_env TF_VAR_cloudflare_zone_id
  require_env TF_VAR_access_allowed_email

  printf 'terraform_dir=%s\n' "$TF_DIR"
  printf 'terraform_backend_bucket=%s\n' "$BACKEND_BUCKET"
  printf 'terraform_backend_profile=%s\n' "$AWS_PROFILE_NAME"
  printf 'aws_region=%s\n' "$AWS_REGION_NAME"
  aws sts get-caller-identity --profile "$AWS_PROFILE_NAME" --output json >/dev/null
  printf 'aws_identity=ok\n'
}

plan() {
  terraform_init
  terraform -chdir="$TF_DIR" plan -input=false -out="$PLAN_FILE"
  terraform -chdir="$TF_DIR" show -no-color "$PLAN_FILE" >"$PLAN_TEXT"
  printf 'plan_file=%s\n' "$PLAN_FILE"
  printf 'plan_text=%s\n' "$PLAN_TEXT"
}

inspect_plan() {
  if [ ! -f "$PLAN_FILE" ]; then
    printf 'Plan file does not exist: %s\n' "$PLAN_FILE" >&2
    exit 1
  fi

  terraform -chdir="$TF_DIR" show -json "$PLAN_FILE" >"$PLAN_JSON"
  node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";

const plan = JSON.parse(readFileSync("infra/terraform/prod/prod-plan.json", "utf8"));
const changes = plan.resource_changes ?? [];
const actionableChanges = changes.filter((change) => {
  const actions = change.change?.actions ?? [];
  return actions.some((action) => action !== "no-op" && action !== "read");
});
const plannedResources = [];
function collectResources(module) {
  plannedResources.push(...(module?.resources ?? []));
  for (const child of module?.child_modules ?? []) {
    collectResources(child);
  }
}
collectResources(plan.planned_values?.root_module);

const replacementOrDestroy = actionableChanges.filter((change) => {
  const actions = change.change?.actions ?? [];
  return actions.includes("delete");
});
const cloudflareDns = actionableChanges.filter((change) => change.type === "cloudflare_record");
const unproxied = cloudflareDns.filter((change) => change.change?.after?.proxied === false);
const endpointDrift = actionableChanges.filter((change) => {
  return change.type === "aws_apigatewayv2_api" && change.change?.after?.disable_execute_api_endpoint !== true;
});
const accessChanges = actionableChanges.filter((change) => change.type?.includes("access"));
const caaRecords = plannedResources.filter((resource) => {
  return resource.type === "cloudflare_record" && resource.values?.type === "CAA";
});

const findings = [];
if (replacementOrDestroy.length > 0) {
  findings.push(`destructive_changes=${replacementOrDestroy.map((change) => change.address).join(",")}`);
}
if (unproxied.length > 0) {
  findings.push(`unproxied_cloudflare_records=${unproxied.map((change) => change.address).join(",")}`);
}
if (endpointDrift.length > 0) {
  findings.push(`api_gateway_default_endpoint_not_disabled=${endpointDrift.map((change) => change.address).join(",")}`);
}
if (accessChanges.length > 0) {
  console.error(`review_access_policy_or_app_changes=${accessChanges.map((change) => change.address).join(",")}`);
}
if (caaRecords.length === 0) {
  findings.push("caa_records=missing");
}

console.log(`resource_changes=${changes.length}`);
console.log(`actionable_changes=${actionableChanges.length}`);
console.log(`caa_records_in_plan=${caaRecords.length}`);

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exit(1);
}

console.log("plan_inspection=ok");
NODE

  if grep -E 'app\.recipes\.rkac\.dev|api\.recipes\.rkac\.dev' "$PLAN_TEXT" >/dev/null; then
    printf 'legacy_hostname_drift=found\n' >&2
    exit 1
  fi
  printf 'legacy_hostname_drift=absent\n'
}

report() {
  {
    printf 'Production infrastructure plan report\n'
    printf 'generated_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'terraform_dir=%s\n' "$TF_DIR"
    printf 'plan_file=%s\n' "$PLAN_FILE"
    printf 'plan_text=%s\n' "$PLAN_TEXT"
    printf 'plan_json=%s\n' "$PLAN_JSON"
    printf '\nPlan summary:\n'
    if [ -f "$PLAN_TEXT" ]; then
      sed -n '1,40p' "$PLAN_TEXT"
    else
      printf 'Plan text has not been generated.\n'
    fi
  } >"$REPORT_FILE"
  printf 'report_file=%s\n' "$REPORT_FILE"
}

case "${1:-}" in
  preflight) preflight ;;
  plan) plan ;;
  inspect-plan) inspect_plan ;;
  report) report ;;
  *) usage; exit 2 ;;
esac
