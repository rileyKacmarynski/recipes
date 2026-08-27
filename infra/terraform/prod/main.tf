locals {
  environment  = "prod"
  name_prefix  = "recipes-prod"
  web_hostname = "recipes.rkac.dev"
  api_hostname = "recipes-api.rkac.dev"

  tags = {
    Project     = "recipes"
    Environment = local.environment
    ManagedBy   = "terraform"
  }
}

module "app_environment" {
  source = "../modules/app_environment"

  environment           = local.environment
  name_prefix           = local.name_prefix
  web_hostname          = local.web_hostname
  api_hostname          = local.api_hostname
  cloudflare_account_id = var.cloudflare_account_id
  cloudflare_zone_id    = var.cloudflare_zone_id
  access_allowed_email  = var.access_allowed_email

  api_lambda_zip_path           = var.api_lambda_zip_path
  api_lambda_source_code_hash   = var.api_lambda_source_code_hash
  cloudflare_access_team_domain = var.cloudflare_access_team_domain
}
