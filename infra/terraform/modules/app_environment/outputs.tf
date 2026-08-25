output "web_url" {
  description = "Web app URL."
  value       = "https://${var.web_hostname}"
}

output "api_url" {
  description = "API URL."
  value       = "https://${var.api_hostname}"
}

output "web_bucket" {
  description = "S3 bucket for web artifacts."
  value       = aws_s3_bucket.web.bucket
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID for web cache invalidations."
  value       = aws_cloudfront_distribution.web.id
}

output "api_lambda_function_name" {
  description = "Lambda function name for API artifact updates."
  value       = aws_lambda_function.api.function_name
}

output "api_gateway_domain_name" {
  description = "API Gateway regional target domain behind Cloudflare."
  value       = aws_apigatewayv2_domain_name.api.domain_name_configuration[0].target_domain_name
}

output "web_access_aud" {
  description = "Cloudflare Access AUD tag for the web app."
  value       = cloudflare_zero_trust_access_application.web.aud
}

output "api_access_aud" {
  description = "Cloudflare Access AUD tag for the API app."
  value       = cloudflare_zero_trust_access_application.api.aud
}
