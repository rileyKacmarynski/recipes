variable "aws_profile" {
  description = "AWS CLI profile used for local Terraform applies."
  type        = string
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

variable "github_repository" {
  description = "GitHub repository allowed to assume the app artifact deploy role."
  type        = string
  default     = "rileyKacmarynski/recipes"
}

variable "terraform_state_bucket" {
  description = "S3 bucket that stores production Terraform state for deploy-time output reads."
  type        = string
  default     = "recipes-terraform-state-699281550169"
}
