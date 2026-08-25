variable "aws_profile" {
  description = "AWS CLI profile used for local Terraform applies."
  type        = string
}

variable "aws_region" {
  description = "AWS region for backend bootstrap resources."
  type        = string
  default     = "us-east-1"
}
