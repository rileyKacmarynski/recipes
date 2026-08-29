variable "environment" {
  description = "The environment of the deployment"
  type        = string
  default     = "production"
}

variable "aws_profile" {
  description = "AWS CLI profile used for local Terraform applies. Leave null when credentials come from the environment, such as in GitHub Actions."
  type        = string
  default     = null
}

variable "aws_region" {
  description = "AWS region for production resources."
  type        = string
  default     = "us-east-1"
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID for Zero Trust Access resources."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for rkac.dev DNS records."
  type        = string
}

variable "access_allowed_email" {
  description = "Email address allowed by the initial Cloudflare Access policies."
  type        = string
}

variable "github_oidc_subject" {
  description = "GitHub OIDC subject allowed to assume the app artifact deploy role."
  type        = string
}

variable "terraform_state_bucket" {
  description = "S3 bucket that stores production Terraform state for deploy-time output reads."
  type        = string
}

variable "api_lambda_zip_path" {
  description = "Path to the deployable API Lambda zip artifact."
  type        = string
}

variable "api_lambda_source_code_hash" {
  description = "Base64-encoded SHA256 hash of the deployable API Lambda zip artifact."
  type        = string
}

variable "cloudflare_access_team_domain" {
  description = "Cloudflare Zero Trust team domain used as the Access JWT issuer, for example team.cloudflareaccess.com."
  type        = string
}
