output "web_url" {
  description = "Production web app URL."
  value       = module.app_environment.web_url
}

output "api_url" {
  description = "Production API URL."
  value       = module.app_environment.api_url
}

output "web_bucket" {
  description = "S3 bucket for web artifacts."
  value       = module.app_environment.web_bucket
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID for web cache invalidations."
  value       = module.app_environment.cloudfront_distribution_id
}

output "api_lambda_function_name" {
  description = "Lambda function name for API artifact updates."
  value       = module.app_environment.api_lambda_function_name
}

output "api_gateway_domain_name" {
  description = "API Gateway regional target domain behind Cloudflare."
  value       = module.app_environment.api_gateway_domain_name
}

output "web_access_aud" {
  description = "Cloudflare Access AUD tag for the web app."
  value       = module.app_environment.web_access_aud
}

output "api_access_aud" {
  description = "Cloudflare Access AUD tag for the API app."
  value       = module.app_environment.api_access_aud
}
