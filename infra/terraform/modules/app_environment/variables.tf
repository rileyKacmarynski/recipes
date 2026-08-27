variable "environment" {
  description = "Deployment environment name."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for environment-scoped resource names."
  type        = string
}

variable "web_hostname" {
  description = "Public web app hostname."
  type        = string
}

variable "api_hostname" {
  description = "Public API hostname."
  type        = string
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID for Zero Trust Access resources."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for app DNS records."
  type        = string
}

variable "access_allowed_email" {
  description = "Email address allowed by the initial Cloudflare Access policies."
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
