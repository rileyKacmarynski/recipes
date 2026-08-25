output "terraform_state_bucket" {
  description = "S3 bucket name for production Terraform state."
  value       = aws_s3_bucket.terraform_state.bucket
}

output "terraform_state_region" {
  description = "AWS region for the Terraform state bucket."
  value       = var.aws_region
}
