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

output "web_bucket_arn" {
  description = "S3 bucket ARN for web artifacts."
  value       = aws_s3_bucket.web.arn
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID for web cache invalidations."
  value       = aws_cloudfront_distribution.web.id
}

output "cloudfront_distribution_arn" {
  description = "CloudFront distribution ARN for web cache invalidations."
  value       = aws_cloudfront_distribution.web.arn
}

output "api_lambda_function_name" {
  description = "Lambda function name for API artifact updates."
  value       = aws_lambda_function.api.function_name
}

output "api_lambda_function_arn" {
  description = "Lambda function ARN for API artifact updates."
  value       = aws_lambda_function.api.arn
}

output "api_gateway_domain_name" {
  description = "API Gateway regional target domain behind Cloudflare."
  value       = aws_apigatewayv2_domain_name.api.domain_name_configuration[0].target_domain_name
}

output "web_access_aud" {
  description = "Cloudflare Access AUD tag for the shared web/API app."
  value       = cloudflare_zero_trust_access_application.web.aud
}

output "api_access_aud" {
  description = "Cloudflare Access AUD tag for the shared web/API app."
  value       = cloudflare_zero_trust_access_application.web.aud
}
